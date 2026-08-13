import type Database from "better-sqlite3";

export type Fact = { text: string; targetNodeId?: number };

const EDGE_VERB: Record<string, string> = {
  performed_by: "Performed by",
  released_in: "Released in",
  appears_on: "Appears on",
  released_on: "Released on",
  remix_of: "Remix of",
  featured_artist: "Featuring",
};

// Template-based, not an LLM call — see Legato.md's article-view spec.
// field_provenance (M2's migration created it) is still empty at this
// point in the roadmap: nothing writes it until M7's enrichment pass adds
// provenance-tracked fields. Facts here come straight from edges (M2's
// local hard edges) and file/tag data instead — the actual source of
// everything currently known about a node.
export function generateFacts(db: Database.Database, nodeId: number): Fact[] {
  const node = db.prepare("SELECT id, type, title FROM nodes WHERE id = ?").get(nodeId) as
    | { id: number; type: string; title: string }
    | undefined;
  if (!node) return [];

  const facts: Fact[] = [];

  const outgoing = db
    .prepare(
      `SELECT e.type, e.to_node AS target_id, n.title, n.type AS target_type
       FROM edges e JOIN nodes n ON n.id = e.to_node
       WHERE e.from_node = ? AND e.source = 'local'
       ORDER BY e.type`,
    )
    .all(nodeId) as { type: string; target_id: number; title: string; target_type: string }[];

  for (const edge of outgoing) {
    const verb = EDGE_VERB[edge.type] ?? edge.type;
    facts.push({ text: `${verb} ${edge.title}`, targetNodeId: edge.target_id });
  }

  if (node.type === "recording") {
    const fileCount = (
      db.prepare("SELECT COUNT(*) AS n FROM files WHERE recording_node_id = ?").get(nodeId) as { n: number }
    ).n;
    if (fileCount > 1) {
      facts.push({ text: `You have this recording across ${fileCount} different releases you own` });
    }
  } else {
    // Non-recording nodes (artist/release/label/year): facts about what
    // connects TO them, since that's the direction hard edges point.
    const incoming = db
      .prepare(
        `SELECT COUNT(DISTINCT e.from_node) AS n
         FROM edges e JOIN nodes rn ON rn.id = e.from_node
         WHERE e.to_node = ? AND rn.type = 'recording'`,
      )
      .get(nodeId) as { n: number };
    if (incoming.n > 0) {
      const noun = incoming.n === 1 ? "recording" : "recordings";
      facts.push({ text: `${incoming.n} ${noun} in your collection` });
    }
  }

  return facts;
}
