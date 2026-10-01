import type { Database } from "../sqlite.js";
import { extraCreditedArtists, splitArtistCredit } from "../scan/artist-credit.js";

type LocalTags = {
  artist?: string | null;
  releaseDate?: string | null;
  album?: string | null;
  label?: string | null;
  producer?: string[] | null;
  engineer?: string[] | null;
  featuredArtists?: string[] | null;
};

// releaseDate is a date string ("1969-09-26", "1969-09", or just "1969") —
// only the leading year matters for the released_in edge.
function extractYear(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const match = /^(\d{4})/.exec(dateStr);
  return match ? Number(match[1]) : null;
}

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
//
// Issue #189: the WHERE clause has to stay character-for-character the
// expression migration 0030 indexes, or SQLite falls back to scanning every
// node — recordings included — on each lookup, and the 'collapse' and
// 'layout' stages go quadratic again. Exported so edges-lookup.spec.ts can
// ask the planner which it gets.
export const NODE_LOOKUP_SQL = "SELECT id FROM nodes WHERE type = ? AND lower(trim(title)) = lower(trim(?))";

function findOrCreateNode(db: Database, type: string, title: string): number {
  const existing = db.prepare(NODE_LOOKUP_SQL).get(type, title) as { id: number } | undefined;
  if (existing) return existing.id;
  const row = db.prepare("INSERT INTO nodes (type, title) VALUES (?, ?) RETURNING id").get(type, title) as {
    id: number;
  };
  return row.id;
}

function insertEdge(db: Database, fromNode: number, toNode: number, type: string): void {
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
export function deriveLocalEdges(db: Database, fileId: number): void {
  const file = db.prepare("SELECT recording_node_id, tags_raw FROM files WHERE id = ?").get(fileId) as
    | { recording_node_id: number; tags_raw: string | null }
    | undefined;
  if (!file) return;

  const tags = parseTagsRaw(file.tags_raw);
  const recordingNodeId = file.recording_node_id;

  db.prepare("DELETE FROM edges WHERE from_node = ? AND source = 'local'").run(recordingNodeId);

  if (!tags) return;

  // One edge per artist the credit names, in credit order. A single ARTIST
  // tag routinely carries several artists ("JPEGMAFIA; Danny Brown"), and
  // storing that string as one node's title gave the graph an artist that
  // doesn't exist while giving Danny Brown none. Order matters downstream:
  // everything that needs one artist for a recording takes the first edge,
  // so the primary performer stays primary. See scan/artist-credit.ts for
  // which separators are safe to split on and, more importantly, which
  // aren't.
  for (const name of splitArtistCredit(tags.artist)) {
    insertEdge(db, recordingNodeId, findOrCreateNode(db, "artist", name), "performed_by");
  }
  // M-7: derived from the same originaldate-first precedence releaseDate
  // itself uses (scan/tags.ts) — previously this read music-metadata's own
  // `common.year`, which tracks the *pressing's* date tag, not the
  // originaldate the release_date column already preferred. A Mobile
  // Fidelity reissue's DATE tag disagreeing with the original recording
  // year is exactly the real case that produced wrong year nodes.
  const year = extractYear(tags.releaseDate);
  if (year != null) {
    insertEdge(db, recordingNodeId, findOrCreateNode(db, "year", String(year)), "released_in");
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
  // Re-filtered against the credit here and not only at scan time, so
  // re-deriving edges repairs a library scanned before the splitter
  // existed: those tags_raw rows still list every ARTISTS value, ensemble
  // fragments included. On a fresh scan this is a no-op, scan/tags.ts
  // having already applied the same rule.
  for (const name of extraCreditedArtists(tags.artist, tags.featuredArtists)) {
    insertEdge(db, recordingNodeId, findOrCreateNode(db, "artist", name), "featured_artist");
  }
}
