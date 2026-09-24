import type { Database } from "../sqlite.js";
import type { MbArtistRelation } from "./mbClient.js";

// Mirrors match/edges.ts's findOrCreateNode and credits.ts's
// findOrCreateCreditNode, scoped to 'artist' nodes — same case/whitespace-
// insensitive collapse, which is exactly what makes issue #61's example
// work: a "George Harrison" node created here from a Beatles member
// relation is the same node his own solo recordings later land on, if
// they're ever scanned into the library. Returns whether the node was
// created so the caller can cascade enrichment onto it — a member/group
// discovered this way starts with no MBID, no photo, and no member
// relations of its own looked up yet.
function findOrCreateArtistNode(db: Database, title: string): { id: number; created: boolean } {
  const existing = db
    .prepare("SELECT id FROM nodes WHERE type = 'artist' AND lower(trim(title)) = lower(trim(?))")
    .get(title) as { id: number } | undefined;
  if (existing) return { id: existing.id, created: false };
  const row = db.prepare("INSERT INTO nodes (type, title) VALUES ('artist', ?) RETURNING id").get(title) as {
    id: number;
  };
  return { id: row.id, created: true };
}

// Canonical edge direction is member -> group ("member_of"), matching
// MusicBrainz's own entity0/entity1 fix for this relation type and the
// issue's own phrasing ("George Harrison... connects to the Beatles").
//
// One MB query per artist (worker.ts's processArtistMemberLookup) returns
// every "member of band" relation touching that artist from BOTH sides at
// once — a group's own page lists its members (direction: backward) and a
// member's own page lists the groups it belongs to (direction: forward) —
// so delete-then-reinsert here has to clear edges touching this node as
// either from_node or to_node, not just the outgoing half applyCredits
// clears for recordings. Re-running is still exactly as idempotent: the
// single fetch this node's job just made is the complete current truth for
// every member_of edge this node participates in, regardless of which side
// it's on.
//
// Returns the ids of artist nodes newly created while applying these
// relations, so the caller can enqueue their own enrichment (photo,
// description, and their own member-relation lookup) rather than waiting
// for the next full recompute to notice them.
export function applyMemberRelations(
  db: Database,
  artistNodeId: number,
  relations: MbArtistRelation[],
): number[] {
  db.prepare(
    "DELETE FROM edges WHERE (from_node = ? OR to_node = ?) AND type = 'member_of' AND source = 'musicbrainz'",
  ).run(artistNodeId, artistNodeId);

  const insertEdge = db.prepare(
    "INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'member_of', 'musicbrainz')",
  );

  const newNodeIds: number[] = [];
  const seenPairs = new Set<string>();
  for (const relation of relations) {
    const { id: otherNodeId, created } = findOrCreateArtistNode(db, relation.name);
    if (otherNodeId === artistNodeId) continue; // guard against a self-relation in MB's data
    if (created) newNodeIds.push(otherNodeId);

    const fromNode = relation.direction === "backward" ? otherNodeId : artistNodeId;
    const toNode = relation.direction === "backward" ? artistNodeId : otherNodeId;

    // MusicBrainz can list the same membership twice across overlapping
    // relationship edits, the same real-world duplication applyCredits
    // already had to guard against for recording-level credits.
    const key = `${fromNode}-${toNode}`;
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);

    insertEdge.run(fromNode, toNode);
  }

  return newNodeIds;
}
