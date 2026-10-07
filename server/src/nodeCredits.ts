import type { Database } from "./sqlite.js";

/* Who made a node, for the details panel's Overview chips and Credits tab
 * (src/panels/NodeDetails.tsx): the recordings it's made of, and every
 * person credited on them, with how many of those recordings each is on.
 *
 * This used to be worked out in the client from the map's graph, which
 * only holds nodes with a map position. Producers and engineers have one;
 * most performer and mixing credits don't, so their names came out as "?"
 * and "–". Names come from the nodes table here, whatever is on the map.
 */

// Edge type -> the role the panel names it by. Listed in the order a tie
// on track count is broken: the people who shaped a record before the
// people who played on it.
const ROLE: Record<string, string> = {
  produced_by: "producer",
  engineered_by: "engineer",
  mixed_by: "mixing",
  performed_by: "artist",
  featured_artist: "featured",
  performed_credit: "performer",
};

export type CreditedPerson = { id: number; title: string; type: string; role: string; count: number };
export type NodeCredits = { tracks: number[]; people: CreditedPerson[] };

// A record is its tracks, an artist is the tracks it performs, and a track
// is itself. Any other node type has no tracks and so no credits.
function tracksOf(db: Database, nodeId: number, type: string): number[] {
  const query =
    type === "recording"
      ? null
      : type === "release"
        ? "SELECT from_node AS id FROM edges WHERE to_node = ? AND type = 'appears_on' ORDER BY id"
        : type === "artist"
          ? `SELECT e.from_node AS id FROM edges e JOIN nodes n ON n.id = e.from_node AND n.type = 'recording'
             WHERE e.to_node = ? AND e.type = 'performed_by' ORDER BY e.id`
          : undefined;
  if (query === null) return [nodeId];
  if (query === undefined) return [];
  return [...new Set((db.prepare(query).all(nodeId) as { id: number }[]).map((r) => r.id))];
}

export function nodeCredits(db: Database, nodeId: number): NodeCredits | null {
  const node = db.prepare("SELECT type FROM nodes WHERE id = ?").get(nodeId) as { type: string } | undefined;
  if (!node) return null;

  const tracks = tracksOf(db, nodeId, node.type);
  if (tracks.length === 0) return { tracks, people: [] };

  const edgeTypes = Object.keys(ROLE);
  const roleOrder = Object.values(ROLE);
  const rows = db
    .prepare(
      `SELECT e.to_node AS id, n.title, n.type, e.type AS edgeType, COUNT(DISTINCT e.from_node) AS count
       FROM edges e JOIN nodes n ON n.id = e.to_node
       WHERE e.from_node IN (${tracks.map(() => "?").join(",")})
         AND e.type IN (${edgeTypes.map(() => "?").join(",")})
       GROUP BY e.to_node, e.type`,
    )
    .all(...tracks, ...edgeTypes) as { id: number; title: string; type: string; edgeType: string; count: number }[];

  const people = rows
    // An artist's own performed_by edges are what make the tracks theirs,
    // not a credit to list under them. Their other roles on those tracks
    // are: issue #273 made Bob Dylan one node, and producing his own
    // records is still a credit his panel shows.
    .filter((r) => !(node.type === "artist" && r.id === nodeId && r.edgeType === "performed_by"))
    .map((r) => ({ id: r.id, title: r.title, type: r.type, role: ROLE[r.edgeType], count: r.count }))
    .sort(
      (a, b) =>
        b.count - a.count || roleOrder.indexOf(a.role) - roleOrder.indexOf(b.role) || a.title.localeCompare(b.title),
    );

  return { tracks, people };
}
