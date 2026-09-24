import type { Database } from "./sqlite.js";

// groupType carries the raw edge type (e.g. "same_artist") so the client
// can collapse repeats of the same relationship into one row with a count
// and a disclosure (P-6) — an artist with fifteen albums otherwise produces
// fifteen near-identical "Same artist as…" lines with nothing to group by
// once they're flattened to text.
export type Fact = { text: string; targetNodeId?: number; groupType?: string };

const EDGE_VERB: Record<string, string> = {
  performed_by: "Performed by",
  released_in: "Released in",
  appears_on: "Appears on",
  released_on: "Released on",
  remix_of: "Remix of",
  featured_artist: "Featuring",
  produced_by: "Produced by",
  engineered_by: "Engineered by",
  collaborated_with: "Collaborated with",
  same_artist: "Same artist as",
  same_label: "Same label as",
  // M-8: MusicBrainz relation types match/edges.ts's local-tag-only pass
  // never had a use for.
  mixed_by: "Mixed by",
  mastered_by: "Mastered by",
  arranged_by: "Arranged by",
  conducted_by: "Conducted by",
  remixed_by: "Remixed by",
  dj_mixed_by: "DJ-mixed by",
};

// Template-based, not an LLM call — see Legato.md's article-view spec.
// field_provenance (M2's migration created it) is still empty at this
// point in the roadmap: nothing writes it until M7's enrichment pass adds
// provenance-tracked fields. Facts here come straight from edges (M2's
// local hard edges) and file/tag data instead — the actual source of
// everything currently known about a node.
export function generateFacts(db: Database, nodeId: number): Fact[] {
  const node = db.prepare("SELECT id, type, title FROM nodes WHERE id = ?").get(nodeId) as
    | { id: number; type: string; title: string }
    | undefined;
  if (!node) return [];

  const facts: Fact[] = [];

  // M-8: source widened from 'local' alone to include 'musicbrainz' — the
  // wider field harvest's credit edges (produced_by/engineered_by/etc. from
  // real MusicBrainz relations, not just local tags) were otherwise
  // written to the graph and never surfaced anywhere.
  const outgoing = db
    .prepare(
      // collaborated_with's own label column doubles as its G-7 affinity
      // marker (entities/collaboration.ts) — same_label/same_era/
      // same_credit for a graph-clustering-only tie, null for one where
      // these two artists actually shared a recording. Excluding the
      // labeled rows here keeps "Collaborated with X" from being asserted
      // about artists who merely share a decade or a producer, while every
      // other edge type still reads e.label for its own purpose
      // (performed_credit's instrument/vocal part, just below).
      // member_of is excluded here too — issue #61's dedicated members/
      // "member of" sections (ConnectionsContent.tsx's MembersList) render
      // both directions of that relation explicitly, the same reason
      // ReleasesList/IncomingRecordingsList already live outside this
      // generic list rather than duplicating through it.
      `SELECT e.type, e.label, e.to_node AS target_id, n.title, n.type AS target_type
       FROM edges e JOIN nodes n ON n.id = e.to_node
       WHERE e.from_node = ? AND e.source IN ('local', 'musicbrainz')
         AND (e.type != 'collaborated_with' OR e.label IS NULL)
         AND e.type != 'member_of'
       ORDER BY e.type`,
    )
    .all(nodeId) as { type: string; label: string | null; target_id: number; title: string; target_type: string }[];

  for (const edge of outgoing) {
    // performed_credit carries the actual instrument/vocal part in its own
    // label (e.g. "electric guitar") rather than a fixed verb — no single
    // EDGE_VERB entry could say "Guitar by" and "Vocals by" both.
    const verb =
      edge.type === "performed_credit" && edge.label
        ? `${edge.label[0].toUpperCase()}${edge.label.slice(1)} by`
        : (EDGE_VERB[edge.type] ?? edge.type);
    facts.push({ text: `${verb} ${edge.title}`, targetNodeId: edge.target_id, groupType: edge.type });
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
