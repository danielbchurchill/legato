import type { Database } from "../sqlite.js";
import { writeInChunks } from "../writeInChunks.js";
import { pickMode } from "./mode.js";

// affinityReason is null for a real tie (shared recording) and a specific
// reason for the three G-7 signals below — the article/facts prose reads
// this to tell "actually worked together" apart from "merely adjacent"
// before claiming a collaboration (articles/recompute.ts, facts.ts). Every
// other consumer (similarity's connected components, layout/seed's
// clustering) still just filters on type and doesn't care.
export type AffinityReason = "same_label" | "same_era" | "same_credit";
export type CollaborationEdge = {
  fromNode: number;
  toNode: number;
  type: "collaborated_with" | "same_artist" | "same_label";
  affinityReason?: AffinityReason;
};

// Unordered pairs, stored as one edge per pair (lower node id first) rather
// than two directed edges — "A collaborated with B" has no natural
// direction, and storing both directions would double every count a
// consumer runs over these edges for no benefit. Deduped globally across
// every group: two artists who share more than one recording (or two
// albums that share both an artist and a label) still produce one edge,
// not one per group they co-occur in.
function pairEdges(
  groups: Iterable<number[]>,
  type: CollaborationEdge["type"],
  affinityReason?: AffinityReason,
): CollaborationEdge[] {
  const seen = new Set<string>();
  const result: CollaborationEdge[] = [];
  for (const members of groups) {
    const sorted = [...new Set(members)].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const key = `${sorted[i]}:${sorted[j]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({ fromNode: sorted[i], toNode: sorted[j], type, affinityReason });
      }
    }
  }
  return result;
}

// Two artists "collaborated" if they're both tied to the same recording via
// a performer-type edge — performed_by (the credited artist) or
// featured_artist (session 4's addition). Producer/engineer credits don't
// count: those are 'credit' nodes, a deliberately different kind of entity
// from the artists graph's own node set (match/edges.ts).
export function computeArtistCollaborations(performerEdges: { fromNode: number; toNode: number }[]): CollaborationEdge[] {
  const artistsByRecording = new Map<number, number[]>();
  for (const e of performerEdges) {
    const list = artistsByRecording.get(e.fromNode);
    if (list) list.push(e.toNode);
    else artistsByRecording.set(e.fromNode, [e.toNode]);
  }
  return pairEdges(artistsByRecording.values(), "collaborated_with");
}

// G-7: 20 artists, 6 collaborated_with edges in the real library — "shared
// a recording" is too narrow a bar to make the artists graph worth
// switching to. Three more signals, each folded into the same
// collaborated_with type rather than a distinct one: the artists graph is
// answering "is there a real tie here", not which kind. recomputeCollaborationEdges
// dedupes the combined result, so a pair connected by more than one signal
// still produces exactly one edge, the same "one edge no matter how many
// groups" rule pairEdges already applies within a single call.
export type CreditedRecording = { recordingNodeId: number; creditNodeId: number };

export function computeArtistAffinities(
  albums: AlbumForRelations[],
  albumLabel: Map<number, number | null>,
  albumEraDecade: Map<number, number | null>,
  performerEdges: { fromNode: number; toNode: number }[],
  creditEdges: CreditedRecording[],
): CollaborationEdge[] {
  const byLabel = new Map<number, number[]>();
  const byEra = new Map<number, number[]>();
  for (const album of albums) {
    if (album.primaryArtistNodeId == null) continue;
    const labelId = albumLabel.get(album.nodeId);
    if (labelId != null) {
      const list = byLabel.get(labelId);
      if (list) list.push(album.primaryArtistNodeId);
      else byLabel.set(labelId, [album.primaryArtistNodeId]);
    }
    const era = albumEraDecade.get(album.nodeId);
    if (era != null) {
      const list = byEra.get(era);
      if (list) list.push(album.primaryArtistNodeId);
      else byEra.set(era, [album.primaryArtistNodeId]);
    }
  }

  // Same producer/engineer credit on two artists' recordings — built from
  // the same performer edges computeArtistCollaborations reads, joined
  // against whichever recordings a credit (M-8's produced_by/engineered_by,
  // or a local one) touches.
  const artistsByRecording = new Map<number, number[]>();
  for (const e of performerEdges) {
    const list = artistsByRecording.get(e.fromNode);
    if (list) list.push(e.toNode);
    else artistsByRecording.set(e.fromNode, [e.toNode]);
  }
  const byCredit = new Map<number, number[]>();
  for (const credit of creditEdges) {
    const artists = artistsByRecording.get(credit.recordingNodeId);
    if (!artists) continue;
    const list = byCredit.get(credit.creditNodeId);
    if (list) list.push(...artists);
    else byCredit.set(credit.creditNodeId, [...artists]);
  }

  return [
    ...pairEdges(byLabel.values(), "collaborated_with", "same_label"),
    ...pairEdges(byEra.values(), "collaborated_with", "same_era"),
    ...pairEdges(byCredit.values(), "collaborated_with", "same_credit"),
  ];
}

export type AlbumForRelations = { nodeId: number; primaryArtistNodeId: number | null };

// Two albums are tied by same_artist when they share a primary artist
// (entities/aggregate.ts) and by same_label when they share a dominant
// label — the mode label among a release's own tracks, computed here via
// released_on edges rather than stored on the albums table: it's read only
// by this one pass, so persisting it would be a column with exactly one
// reader.
export function computeAlbumRelations(
  albums: AlbumForRelations[],
  albumLabel: Map<number, number | null>,
): CollaborationEdge[] {
  const byArtist = new Map<number, number[]>();
  const byLabel = new Map<number, number[]>();

  for (const album of albums) {
    if (album.primaryArtistNodeId != null) {
      const list = byArtist.get(album.primaryArtistNodeId);
      if (list) list.push(album.nodeId);
      else byArtist.set(album.primaryArtistNodeId, [album.nodeId]);
    }
    const labelId = albumLabel.get(album.nodeId);
    if (labelId != null) {
      const list = byLabel.get(labelId);
      if (list) list.push(album.nodeId);
      else byLabel.set(labelId, [album.nodeId]);
    }
  }

  return [...pairEdges(byArtist.values(), "same_artist"), ...pairEdges(byLabel.values(), "same_label")];
}

// Recomputed wholesale after every scan (called from scan/scanner.ts
// alongside recomputeEntities) — same reasoning: cheap at real-library
// scale, avoids keeping a derived graph in sync across collapse/re-scan/
// manual-edge flows. Stored as source='local' (entirely derived from local
// tag data, no MusicBrainz/Discogs/manual involvement) — safe to co-exist
// with deriveLocalEdges's own source='local' rows because that function
// only ever deletes edges scoped to one specific recording's from_node,
// and these edges' from_node values are always artist/release ids, never
// recording ids.
// A release's dominant label — the mode label node among its own tracks'
// released_on edges. Exported for layout/seed.ts too: the albums/artists
// graph layouts (session 4) cluster by the same label affinity this module
// already needs for same_label edges, so it's one query with two readers
// rather than two copies of the same join.
export function getAlbumLabelMap(db: Database): Map<number, number | null> {
  const labelRows = db
    .prepare(
      `SELECT release.to_node AS releaseNodeId, label.to_node AS labelNodeId
       FROM edges release
       JOIN edges label ON label.from_node = release.from_node AND label.type = 'released_on'
       WHERE release.type = 'appears_on'`,
    )
    .all() as { releaseNodeId: number; labelNodeId: number }[];

  const labelCountsByAlbum = new Map<number, Map<number, number>>();
  for (const { releaseNodeId, labelNodeId } of labelRows) {
    let counts = labelCountsByAlbum.get(releaseNodeId);
    if (!counts) {
      counts = new Map();
      labelCountsByAlbum.set(releaseNodeId, counts);
    }
    counts.set(labelNodeId, (counts.get(labelNodeId) ?? 0) + 1);
  }
  const albumLabel = new Map<number, number | null>();
  for (const [releaseNodeId, counts] of labelCountsByAlbum) {
    albumLabel.set(releaseNodeId, pickMode(counts));
  }
  return albumLabel;
}

// Global dedup across every source that can produce a collaborated_with
// edge (direct performer co-occurrence, shared label, shared era, shared
// credit) — pairEdges only dedupes within its own call, and these come
// from three separate calls now. The key deliberately excludes
// affinityReason and is first-wins: computeArtistCollaborations' real,
// no-reason ties are concatenated first in recomputeCollaborationEdges, so
// a pair tied by both an actual shared recording and, say, a shared label
// keeps its real (affinityReason: undefined) edge rather than being
// downgraded to an affinity-only one.
function dedupeEdges(edges: CollaborationEdge[]): CollaborationEdge[] {
  const seen = new Set<string>();
  const result: CollaborationEdge[] = [];
  for (const e of edges) {
    const key = `${e.fromNode}:${e.toNode}:${e.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(e);
  }
  return result;
}

export function recomputeCollaborationEdges(db: Database): void {
  const performerEdges = db
    .prepare(
      "SELECT from_node AS fromNode, to_node AS toNode FROM edges WHERE type IN ('performed_by', 'featured_artist')",
    )
    .all() as { fromNode: number; toNode: number }[];

  const albums = db
    .prepare("SELECT node_id AS nodeId, primary_artist_node_id AS primaryArtistNodeId, year_min AS yearMin FROM albums")
    .all() as { nodeId: number; primaryArtistNodeId: number | null; yearMin: number | null }[];

  const albumLabel = getAlbumLabelMap(db);
  const albumEraDecade = new Map<number, number | null>(
    albums.map((a) => [a.nodeId, a.yearMin != null ? Math.floor(a.yearMin / 10) * 10 : null]),
  );

  const creditEdges = db
    .prepare(
      "SELECT from_node AS recordingNodeId, to_node AS creditNodeId FROM edges WHERE type IN ('produced_by', 'engineered_by')",
    )
    .all() as CreditedRecording[];

  const edges = dedupeEdges([
    ...computeArtistCollaborations(performerEdges),
    ...computeArtistAffinities(albums, albumLabel, albumEraDecade, performerEdges, creditEdges),
    ...computeAlbumRelations(albums, albumLabel),
  ]);

  // affinityReason rides in the edges table's existing label column —
  // null for a real collaborated_with tie, the reason string for an
  // affinity-only one. articles/recompute.ts and facts.ts both filter on
  // it before claiming two artists "collaborated".
  const edgeKey = (fromNode: number, toNode: number, type: string, label: string | null) =>
    `${fromNode}:${toNode}:${type}:${label ?? ""}`;
  const missing = new Map(edges.map((e) => [edgeKey(e.fromNode, e.toNode, e.type, e.affinityReason ?? null), e]));

  // Issue #281: written as a diff rather than deleted and inserted whole.
  // The era affinity alone is about 750,000 pairs on a 3,000-artist
  // library, and rewriting them held the write lock for seconds on every
  // scan; a rescan that changed nothing now writes nothing. Every edge of
  // these types that isn't wanted goes, a duplicate or one from another
  // source included, as the wholesale delete always did.
  const existing = db
    .prepare(
      `SELECT id, from_node AS fromNode, to_node AS toNode, type, source, label FROM edges
        WHERE type IN ('collaborated_with', 'same_artist', 'same_label')`,
    )
    .all() as { id: number; fromNode: number; toNode: number; type: string; source: string; label: string | null }[];
  const stale: number[] = [];
  for (const row of existing) {
    if (row.source === "local" && missing.delete(edgeKey(row.fromNode, row.toNode, row.type, row.label))) continue;
    stale.push(row.id);
  }

  const remove = db.prepare("DELETE FROM edges WHERE id = ?");
  const insert = db.prepare("INSERT INTO edges (from_node, to_node, type, source, label) VALUES (?, ?, ?, 'local', ?)");
  writeInChunks(db, stale, (id) => remove.run(id));
  writeInChunks(db, [...missing.values()], (e) => insert.run(e.fromNode, e.toNode, e.type, e.affinityReason ?? null));
}
