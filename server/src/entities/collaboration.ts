import type Database from "better-sqlite3";
import { pickMode } from "./mode.js";

export type CollaborationEdge = { fromNode: number; toNode: number; type: "collaborated_with" | "same_artist" | "same_label" };

// Unordered pairs, stored as one edge per pair (lower node id first) rather
// than two directed edges — "A collaborated with B" has no natural
// direction, and storing both directions would double every count a
// consumer runs over these edges for no benefit. Deduped globally across
// every group: two artists who share more than one recording (or two
// albums that share both an artist and a label) still produce one edge,
// not one per group they co-occur in.
function pairEdges(groups: Iterable<number[]>, type: CollaborationEdge["type"]): CollaborationEdge[] {
  const seen = new Set<string>();
  const result: CollaborationEdge[] = [];
  for (const members of groups) {
    const sorted = [...new Set(members)].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const key = `${sorted[i]}:${sorted[j]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({ fromNode: sorted[i], toNode: sorted[j], type });
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
export function recomputeCollaborationEdges(db: Database.Database): void {
  const performerEdges = db
    .prepare(
      "SELECT from_node AS fromNode, to_node AS toNode FROM edges WHERE type IN ('performed_by', 'featured_artist')",
    )
    .all() as { fromNode: number; toNode: number }[];

  const albums = db.prepare("SELECT node_id AS nodeId, primary_artist_node_id AS primaryArtistNodeId FROM albums").all() as {
    nodeId: number;
    primaryArtistNodeId: number | null;
  }[];

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

  const edges = [...computeArtistCollaborations(performerEdges), ...computeAlbumRelations(albums, albumLabel)];

  const applyAll = db.transaction(() => {
    db.prepare("DELETE FROM edges WHERE type IN ('collaborated_with', 'same_artist', 'same_label')").run();
    const insert = db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, ?, 'local')");
    for (const e of edges) insert.run(e.fromNode, e.toNode, e.type);
  });
  applyAll();
}
