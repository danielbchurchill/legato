import type Database from "better-sqlite3";
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

  // At most one performed_by edge per recording today (deriveLocalEdges
  // creates exactly one, from tags.artist) — .set() on first-seen is a
  // no-op in practice, and stays correct if that ever changes to "keep the
  // first credited artist" for a multi-performer recording.
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

// Recomputed wholesale after every scan (called from scan/scanner.ts
// alongside recomputeAllLayouts) rather than maintained incrementally —
// cheap at real-library scale and avoids keeping running aggregates in
// sync across collapse, re-scan, and manual-edge flows. Rows for entities
// that no longer have any tracks are left stale rather than deleted, the
// same tolerance layout/seed.ts's positions table already has.
export function recomputeEntities(db: Database.Database): void {
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

  const applyAll = db.transaction(() => {
    for (const a of albums) {
      upsertAlbum.run(a.nodeId, a.primaryArtistNodeId, a.trackCount, a.totalDurationMs, a.yearMin, a.yearMax);
    }
    for (const a of artists) {
      upsertArtist.run(a.nodeId, a.trackCount, a.albumCount);
    }
  });
  applyAll();
}
