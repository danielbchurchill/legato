import type Database from "better-sqlite3";

type LocalTags = {
  artist?: string | null;
  year?: number | null;
  album?: string | null;
  label?: string | null;
  producer?: string[] | null;
  engineer?: string[] | null;
  featuredArtists?: string[] | null;
};

function parseTagsRaw(tagsRaw: string | null): LocalTags | null {
  if (!tagsRaw) return null;
  try {
    return JSON.parse(tagsRaw) as LocalTags;
  } catch {
    return null;
  }
}

// Non-recording node types are deduped by (type, title) at the application
// level rather than a DB constraint — a blanket UNIQUE(type, title) index
// would be wrong for 'recording' nodes (two different songs can share a
// title), so this helper is only used for artist/release/year nodes, where
// same-title-means-same-node is the correct v1 collapse rule. Matching is
// case/whitespace-insensitive (lower+trim on both sides) so "The Beatles"
// and "the beatles " — the same artist, tagged inconsistently across a
// real library — collapse into one node instead of fragmenting the entity
// aggregates in entities/aggregate.ts. Safe without a transaction/lock:
// better-sqlite3 is fully synchronous, so there's no interleaving between
// the SELECT and the INSERT within one process.
function findOrCreateNode(db: Database.Database, type: string, title: string): number {
  const existing = db
    .prepare("SELECT id FROM nodes WHERE type = ? AND lower(trim(title)) = lower(trim(?))")
    .get(type, title) as { id: number } | undefined;
  if (existing) return existing.id;
  const row = db.prepare("INSERT INTO nodes (type, title) VALUES (?, ?) RETURNING id").get(type, title) as {
    id: number;
  };
  return row.id;
}

function insertEdge(db: Database.Database, fromNode: number, toNode: number, type: string): void {
  db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, ?, 'local')").run(
    fromNode,
    toNode,
    type,
  );
}

// Hard edges derivable from locally embedded tags alone. Session 2 (M2)
// only used performer/year/release — producer/engineer/label/featured-
// artist were assumed to need live MusicBrainz relationship data, but
// music-metadata already exposes all four from local tags alone
// (scan/tags.ts), same as the original three; there was never an M7
// dependency here, just an unexamined assumption.
//
// Re-derives from scratch on every call: deletes this recording's own
// source='local' edges first, then reinserts. The WHERE clause is scoped to
// source='local' specifically — never touches source='manual' rows, which
// is the actual mechanism behind "manual edges survive re-scan" (M5).
export function deriveLocalEdges(db: Database.Database, fileId: number): void {
  const file = db.prepare("SELECT recording_node_id, tags_raw FROM files WHERE id = ?").get(fileId) as
    | { recording_node_id: number; tags_raw: string | null }
    | undefined;
  if (!file) return;

  const tags = parseTagsRaw(file.tags_raw);
  const recordingNodeId = file.recording_node_id;

  db.prepare("DELETE FROM edges WHERE from_node = ? AND source = 'local'").run(recordingNodeId);

  if (!tags) return;

  if (tags.artist) {
    insertEdge(db, recordingNodeId, findOrCreateNode(db, "artist", tags.artist), "performed_by");
  }
  if (tags.year) {
    insertEdge(db, recordingNodeId, findOrCreateNode(db, "year", String(tags.year)), "released_in");
  }
  if (tags.album) {
    insertEdge(db, recordingNodeId, findOrCreateNode(db, "release", tags.album), "appears_on");
  }
  if (tags.label) {
    insertEdge(db, recordingNodeId, findOrCreateNode(db, "label", tags.label), "released_on");
  }
  // Producer/engineer are credit-role people, kept as 'credit' nodes rather
  // than 'artist' nodes — a studio engineer isn't a collection entity the
  // artists graph (session 4) should treat the same as a performer, even
  // though the same real person could in principle be both.
  for (const name of tags.producer ?? []) {
    insertEdge(db, recordingNodeId, findOrCreateNode(db, "credit", name), "produced_by");
  }
  for (const name of tags.engineer ?? []) {
    insertEdge(db, recordingNodeId, findOrCreateNode(db, "credit", name), "engineered_by");
  }
  // Featured artists, unlike producers/engineers, are performers — they get
  // 'artist' nodes so they're the same kind of entity performed_by already
  // creates, which is what lets the collaboration graph (session 4) treat
  // "performed on" and "featured on" as the same kind of tie.
  for (const name of tags.featuredArtists ?? []) {
    insertEdge(db, recordingNodeId, findOrCreateNode(db, "artist", name), "featured_artist");
  }
}
