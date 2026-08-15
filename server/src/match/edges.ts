import type Database from "better-sqlite3";

type LocalTags = {
  artist?: string | null;
  year?: number | null;
  album?: string | null;
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

// Hard edges derivable from locally embedded tags alone — performer, year,
// and the release a track appears on. MusicBrainz-relationship edges
// (producer/engineer/label/remix-of) need live enrichment data and are
// M7's job, not this.
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
}
