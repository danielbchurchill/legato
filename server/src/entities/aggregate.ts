import type { Database } from "../sqlite.js";
import { writeInChunks } from "../writeInChunks.js";
import { pickMode } from "./mode.js";

export type EdgeRef = { fromNode: number; toNode: number };

export type AlbumAggregate = {
  nodeId: number;
  primaryArtistNodeId: number | null;
  trackCount: number;
  totalDurationMs: number;
  yearMin: number | null;
  yearMax: number | null;
};

export type ArtistAggregate = {
  nodeId: number;
  trackCount: number;
  albumCount: number;
};

// Pure aggregation over the same 'appears_on'/'performed_by' hard edges
// match/edges.ts derives per file — split out from the DB-reading orchestrator
// below so the aggregation logic (mode, sums, min/max) is unit-testable
// without a real database, matching layout/cluster.ts's computeClusteredSeeds/
// layout/seed.ts orchestrator split.
export function computeAlbumAggregates(
  appearsOn: EdgeRef[],
  performedBy: EdgeRef[],
  recordingDurationMs: Map<number, number | null>,
  recordingYear: Map<number, number | null>,
): AlbumAggregate[] {
  const recordingsByRelease = new Map<number, number[]>();
  for (const e of appearsOn) {
    const list = recordingsByRelease.get(e.toNode);
    if (list) list.push(e.fromNode);
    else recordingsByRelease.set(e.toNode, [e.fromNode]);
  }

  // A recording can carry several performed_by edges — deriveLocalEdges
  // creates one per artist named in the credit, so "JPEGMAFIA; Danny
  // Brown" produces two. First-seen wins, and since match/edges.ts inserts
  // in credit order that is the primary performer: an album stays filed
  // under JPEGMAFIA rather than under whoever the mode happened to favour.
  const artistByRecording = new Map<number, number>();
  for (const e of performedBy) {
    if (!artistByRecording.has(e.fromNode)) artistByRecording.set(e.fromNode, e.toNode);
  }

  const result: AlbumAggregate[] = [];
  for (const [releaseNodeId, recordingIds] of recordingsByRelease) {
    const totalDurationMs = recordingIds.reduce((sum, id) => sum + (recordingDurationMs.get(id) ?? 0), 0);

    const years = recordingIds
      .map((id) => recordingYear.get(id))
      .filter((y): y is number => y != null && !Number.isNaN(y));

    const artistCounts = new Map<number, number>();
    for (const id of recordingIds) {
      const artistId = artistByRecording.get(id);
      if (artistId == null) continue;
      artistCounts.set(artistId, (artistCounts.get(artistId) ?? 0) + 1);
    }
    result.push({
      nodeId: releaseNodeId,
      // Mode, ties broken by lowest node id — deterministic across
      // recomputes when a compilation has no single dominant artist.
      primaryArtistNodeId: pickMode(artistCounts),
      trackCount: recordingIds.length,
      totalDurationMs,
      yearMin: years.length > 0 ? Math.min(...years) : null,
      yearMax: years.length > 0 ? Math.max(...years) : null,
    });
  }
  return result;
}

// performerEdges is performed_by + featured_artist combined — an artist
// credited only as a featured guest, never as the primary performer on any
// track, is still a real artist entity. Missing this made such an artist
// invisible everywhere downstream: no albums/artists table row, so no
// layout/seed.ts position, so they silently vanished from the artists
// graph despite having real entities/collaboration.ts collaborated_with
// edges pointing at them — confirmed live: nodes 410/411/412 had
// collaborated_with edges but never appeared in GET /nodes?granularity=
// artists, because they'd never once been the primary performed_by
// credit on a track, only a featured one.
export function computeArtistAggregates(appearsOn: EdgeRef[], performerEdges: EdgeRef[]): ArtistAggregate[] {
  const releaseByRecording = new Map<number, number>();
  for (const e of appearsOn) {
    if (!releaseByRecording.has(e.fromNode)) releaseByRecording.set(e.fromNode, e.toNode);
  }

  const tracksByArtist = new Map<number, Set<number>>();
  const albumsByArtist = new Map<number, Set<number>>();
  for (const e of performerEdges) {
    const artistId = e.toNode;
    const recordingId = e.fromNode;

    let tracks = tracksByArtist.get(artistId);
    if (!tracks) {
      tracks = new Set();
      tracksByArtist.set(artistId, tracks);
    }
    tracks.add(recordingId);

    const releaseId = releaseByRecording.get(recordingId);
    if (releaseId != null) {
      let albums = albumsByArtist.get(artistId);
      if (!albums) {
        albums = new Set();
        albumsByArtist.set(artistId, albums);
      }
      albums.add(releaseId);
    }
  }

  return [...tracksByArtist.entries()].map(([nodeId, tracks]) => ({
    nodeId,
    trackCount: tracks.size,
    albumCount: albumsByArtist.get(nodeId)?.size ?? 0,
  }));
}

export type ArtistRelease = {
  id: number;
  title: string;
  trackCount: number;
  totalDurationMs: number;
  yearMin: number | null;
  yearMax: number | null;
};

// Issue #33: an artist's discography, read straight from the albums table
// this file recomputes wholesale after every scan — the real release
// entities primary_artist_node_id already ties to this artist, not a
// client-side regrouping of the flattened recording list GET /nodes/:id
// also returns. Ordered oldest-first (undated releases last) since a
// discography reads chronologically by default.
export function listArtistReleases(db: Database, artistNodeId: number): ArtistRelease[] {
  return db
    .prepare(
      `SELECT n.id AS id, n.title AS title, al.track_count AS trackCount,
              al.total_duration_ms AS totalDurationMs, al.year_min AS yearMin, al.year_max AS yearMax
       FROM albums al JOIN nodes n ON n.id = al.node_id
       WHERE al.primary_artist_node_id = ?
       ORDER BY al.year_min IS NULL, al.year_min, n.title`,
    )
    .all(artistNodeId) as ArtistRelease[];
}

// Recomputed wholesale after every scan (called from scan/scanner.ts
// alongside recomputeAllLayouts) rather than maintained incrementally —
// cheap at real-library scale and avoids keeping running aggregates in
// sync across collapse, re-scan, and manual-edge flows. Rows for entities
// that no longer have any tracks are left stale rather than deleted, the
// same tolerance layout/seed.ts's positions table already has.
// Entities are recomputed as a complete set every run, so a row already in
// the table that this run didn't produce has stopped being one: a release
// whose last file left the library, or — far more common — an artist node
// that only existed because a multi-artist credit was once stored verbatim
// as a single name. Upsert-only left those behind forever, and a stale
// artists row keeps a stale positions row alive with it (layout/seed.ts),
// which is all it takes to leave a ghost sitting on the graph long after
// every edge that justified it is gone.
//
// Prunes against the ids this run computed rather than a SQL rewrite of the
// same rule — two expressions of "what counts as an artist" would drift,
// and the one in SQL would be the one nobody remembered to update.
function pruneEntities(db: Database, table: "albums" | "artists", keep: number[]): void {
  db.prepare("CREATE TEMP TABLE IF NOT EXISTS entity_keep (node_id INTEGER PRIMARY KEY)").run();
  db.prepare("DELETE FROM entity_keep").run();
  const insert = db.prepare("INSERT OR IGNORE INTO entity_keep (node_id) VALUES (?)");
  for (const id of keep) insert.run(id);
  // Table name is a literal union, not caller input — no injection surface.
  db.prepare(`DELETE FROM ${table} WHERE node_id NOT IN (SELECT node_id FROM entity_keep)`).run();
}

export function recomputeEntities(db: Database): void {
  const appearsOn = db
    .prepare("SELECT from_node AS fromNode, to_node AS toNode FROM edges WHERE type = 'appears_on'")
    .all() as EdgeRef[];
  const performedBy = db
    .prepare("SELECT from_node AS fromNode, to_node AS toNode FROM edges WHERE type = 'performed_by'")
    .all() as EdgeRef[];
  // Album primary-artist selection (computeAlbumAggregates) deliberately
  // stays performed_by-only — a featured guest on a couple of tracks
  // shouldn't contend for "primary artist of this album" against the
  // actual album artist. Artist *entity* membership (computeArtistAggregates)
  // is the opposite case: a featured-only artist is still a real artist.
  const performerEdges = db
    .prepare("SELECT from_node AS fromNode, to_node AS toNode FROM edges WHERE type IN ('performed_by', 'featured_artist')")
    .all() as EdgeRef[];

  const durationRows = db.prepare("SELECT node_id AS nodeId, canonical_duration_ms AS durationMs FROM recordings").all() as {
    nodeId: number;
    durationMs: number | null;
  }[];
  const recordingDurationMs = new Map(durationRows.map((r) => [r.nodeId, r.durationMs]));

  const yearRows = db
    .prepare(
      `SELECT e.from_node AS nodeId, CAST(n.title AS INTEGER) AS year
       FROM edges e JOIN nodes n ON n.id = e.to_node
       WHERE e.type = 'released_in'`,
    )
    .all() as { nodeId: number; year: number | null }[];
  const recordingYear = new Map(yearRows.map((r) => [r.nodeId, r.year]));

  const albums = computeAlbumAggregates(appearsOn, performedBy, recordingDurationMs, recordingYear);
  const artists = computeArtistAggregates(appearsOn, performerEdges);

  const upsertAlbum = db.prepare(
    `INSERT INTO albums (node_id, primary_artist_node_id, track_count, total_duration_ms, year_min, year_max)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(node_id) DO UPDATE SET
       primary_artist_node_id = excluded.primary_artist_node_id,
       track_count = excluded.track_count,
       total_duration_ms = excluded.total_duration_ms,
       year_min = excluded.year_min,
       year_max = excluded.year_max,
       updated_at = datetime('now')`,
  );
  const upsertArtist = db.prepare(
    `INSERT INTO artists (node_id, track_count, album_count)
     VALUES (?, ?, ?)
     ON CONFLICT(node_id) DO UPDATE SET
       track_count = excluded.track_count,
       album_count = excluded.album_count,
       updated_at = datetime('now')`,
  );

  // Issue #281: in pieces (writeInChunks.ts), so recompute's worker never
  // holds the write lock for long.
  writeInChunks(db, albums, (a) =>
    upsertAlbum.run(a.nodeId, a.primaryArtistNodeId, a.trackCount, a.totalDurationMs, a.yearMin, a.yearMax),
  );
  writeInChunks(db, artists, (a) => upsertArtist.run(a.nodeId, a.trackCount, a.albumCount));
  db.transaction(() => {
    pruneEntities(db, "albums", albums.map((a) => a.nodeId));
    pruneEntities(db, "artists", artists.map((a) => a.nodeId));
  })();
}
