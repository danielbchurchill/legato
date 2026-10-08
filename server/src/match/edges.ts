import type { Database } from "../sqlite.js";
import { extraCreditedArtists, splitArtistCredit, splitJoinedNames } from "../scan/artist-credit.js";
import { creditEvidence, performerEvidence } from "./evidence.js";
import { retireNodeInto } from "./people.js";

type LocalTags = {
  artist?: string | null;
  releaseDate?: string | null;
  album?: string | null;
  label?: string | null;
  producer?: string[] | null;
  engineer?: string[] | null;
  featuredArtists?: string[] | null;
  artists?: string[] | null;
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

/** Issue #273: one person, one node. A producer, engineer or performer
 *  credit lands on the artist node of the same name when there is one. A
 *  performer who so far only had a credit node takes that node over,
 *  retyped in place, so it keeps its id, favourite and map position. The
 *  roles are carried by the edges, which is where the details panel reads
 *  them from (nodeCredits.ts). Existing pairs are merged by
 *  match/people.ts. Exported for enrich/credits.ts's MusicBrainz credits. */
export function findOrCreatePerson(db: Database, role: "artist" | "credit", name: string): number {
  const artist = db.prepare(NODE_LOOKUP_SQL).get("artist", name) as { id: number } | undefined;
  if (artist) return artist.id;
  const credit = db.prepare(NODE_LOOKUP_SQL).get("credit", name) as { id: number } | undefined;
  if (!credit) return findOrCreateNode(db, role, name);
  if (role === "artist") {
    db.prepare("UPDATE nodes SET type = 'artist', updated_at = datetime('now') WHERE id = ?").run(credit.id);
  }
  return credit.id;
}

// The person edges this file's tags create, as opposed to the year, album
// and label ones.
const PERSON_EDGE_TYPES = ["performed_by", "featured_artist", "produced_by", "engineered_by"];

function localPersonTargets(db: Database, recordingNodeId: number): number[] {
  return (
    db
      .prepare(
        `SELECT DISTINCT to_node AS id FROM edges
          WHERE from_node = ? AND source = 'local' AND type IN (${PERSON_EDGE_TYPES.map(() => "?").join(",")})`,
      )
      .all(recordingNodeId, ...PERSON_EDGE_TYPES) as { id: number }[]
  ).map((r) => r.id);
}

// Issue #273: when a line like "Cage The Elephant, Alison Mosshart" splits,
// the node named after the whole line loses this recording's edge to it. If
// no other recording still credits it, it is retired into the line's first
// artist (the primary performer), which takes its favourite, user-made
// connections and map position (match/people.ts's retireNodeInto). It's only retired when
// every name its title splits into is among the people this recording now
// credits, so an artist dropped because a tag was edited is left alone, as
// it always has been. The derived types recomputeCollaborationEdges
// (entities/collaboration.ts) rebuilds from scratch don't count as use.
function retireSplitLines(db: Database, recordingNodeId: number, before: number[], evidence: string[]): void {
  const after = new Set(localPersonTargets(db, recordingNodeId));
  for (const id of before) {
    if (after.has(id)) continue;
    const node = db.prepare("SELECT title FROM nodes WHERE id = ? AND type IN ('artist', 'credit')").get(id) as
      | { title: string }
      | undefined;
    if (!node) continue;
    const parts = splitArtistCredit(node.title, evidence).map(
      (name) => (db.prepare(NODE_LOOKUP_SQL).get("artist", name) ?? db.prepare(NODE_LOOKUP_SQL).get("credit", name)) as
        | { id: number }
        | undefined,
    );
    if (parts.length < 2 || !parts.every((part) => part && after.has(part.id))) continue;
    const stillUsed = db
      .prepare(
        `SELECT 1 FROM edges WHERE (from_node = ? OR to_node = ?) AND source != 'manual'
           AND type NOT IN ('collaborated_with', 'same_artist', 'same_label')`,
      )
      .get(id, id);
    if (stillUsed) continue;
    retireNodeInto(db, id, parts[0]!.id);
  }
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
//
// Issue #281: one transaction per call. recompute() derives every file on its own connection
// (recompute.ts) while a scan, the watcher or the enrichment worker can be
// deriving one on the request loop's, and two runs of the delete and the
// inserts interleaving on one recording would leave its edges doubled.
export function deriveLocalEdges(db: Database, fileId: number): void {
  db.transaction(() => deriveFileEdges(db, fileId))();
}

function deriveFileEdges(db: Database, fileId: number): void {
  const file = db.prepare("SELECT recording_node_id, tags_raw FROM files WHERE id = ?").get(fileId) as
    | { recording_node_id: number; tags_raw: string | null }
    | undefined;
  if (!file) return;

  const tags = parseTagsRaw(file.tags_raw);
  const recordingNodeId = file.recording_node_id;
  const before = localPersonTargets(db, recordingNodeId);

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
  //
  // Issue #273: the evidence is what splits a line joined by "," or "&",
  // which the separators alone never do (match/evidence.ts).
  const performers = performerEvidence(db, recordingNodeId, tags);
  for (const name of splitArtistCredit(tags.artist, performers)) {
    insertEdge(db, recordingNodeId, findOrCreatePerson(db, "artist", name), "performed_by");
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
  // artists graph (session 4) should treat the same as a performer. Issue
  // #273: unless they are one. A producer who also performs is the artist
  // node (findOrCreatePerson), and a producer line joined by "," or "&" is
  // split when MusicBrainz credits its people one by one. Only the evidence
  // splits these lines, not the separators: producer tags have never been
  // split on ";" or "feat.", and #273 didn't ask for that.
  const credited = tags.producer || tags.engineer ? creditEvidence(db, recordingNodeId, performers) : [];
  for (const line of tags.producer ?? []) {
    for (const name of splitJoinedNames(line, credited)) {
      insertEdge(db, recordingNodeId, findOrCreatePerson(db, "credit", name), "produced_by");
    }
  }
  for (const line of tags.engineer ?? []) {
    for (const name of splitJoinedNames(line, credited)) {
      insertEdge(db, recordingNodeId, findOrCreatePerson(db, "credit", name), "engineered_by");
    }
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
    insertEdge(db, recordingNodeId, findOrCreatePerson(db, "artist", name), "featured_artist");
  }

  if (before.length > 0) retireSplitLines(db, recordingNodeId, before, [...performers, ...credited]);
}

/** Re-derives every present file of one recording, for evidence that
 *  arrives after the scan: a MusicBrainz match, or a file's ARTISTS tag
 *  read again (enrich/artistCredit.ts). */
export function deriveRecordingEdges(db: Database, recordingNodeId: number): void {
  const files = db
    .prepare("SELECT id FROM files WHERE recording_node_id = ? AND missing_since IS NULL ORDER BY id")
    .all(recordingNodeId) as { id: number }[];
  for (const { id } of files) deriveLocalEdges(db, id);
}
