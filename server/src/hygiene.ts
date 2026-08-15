import type Database from "better-sqlite3";

export type WorklistItem =
  | {
      type: "fuzzy_pending";
      fileId: number;
      filePath: string;
      nodeId: number;
      nodeTitle: string;
      candidateNodeId: number;
      candidateTitle: string;
    }
  | { type: "enrichment_flag"; nodeId: number; nodeTitle: string; note: string | null; updatedAt: string }
  | { type: "missing_file"; fileId: number; filePath: string; nodeId: number; nodeTitle: string; missingSince: string };

// Aggregates every "needs a human" signal already produced elsewhere in
// the pipeline: tier-3 fuzzy candidates (M2, never auto-merged),
// enrichment ambiguity/no-match/malformed-tag flags (M7, recorded via
// field_provenance), and files that vanished from disk (M1, never
// deleted, just marked).
export function getWorklist(db: Database.Database, typeFilter?: string): WorklistItem[] {
  const items: WorklistItem[] = [];

  if (!typeFilter || typeFilter === "fuzzy_pending") {
    const rows = db
      .prepare(
        `SELECT f.id AS file_id, f.file_path, n.id AS node_id, n.title AS node_title,
                c.id AS candidate_node_id, c.title AS candidate_title
         FROM files f
         JOIN nodes n ON n.id = f.recording_node_id
         JOIN nodes c ON c.id = f.fuzzy_candidate_node_id
         WHERE f.match_source = 'fuzzy_pending'`,
      )
      .all() as {
      file_id: number;
      file_path: string;
      node_id: number;
      node_title: string;
      candidate_node_id: number;
      candidate_title: string;
    }[];
    for (const r of rows) {
      items.push({
        type: "fuzzy_pending",
        fileId: r.file_id,
        filePath: r.file_path,
        nodeId: r.node_id,
        nodeTitle: r.node_title,
        candidateNodeId: r.candidate_node_id,
        candidateTitle: r.candidate_title,
      });
    }
  }

  if (!typeFilter || typeFilter === "enrichment_flag") {
    // Only the latest mbid provenance row per node — enrichment can retry,
    // and an old flag shouldn't linger after a newer attempt superseded
    // it. Filtered on value IS NULL, not a confidence threshold: M-3's
    // weighted scorer means a genuinely successful match's own confidence
    // is now anywhere from ~0.35 (textSearch.ts's MIN_CONFIDENCE floor) to
    // 1.0, not a clean always-exactly-1 — a `confidence < 1` filter here
    // would flag most real matches as needing attention. applyMatch always
    // writes a real mbid as `value`; every "needs a human" outcome
    // (ambiguous/no_match/malformed tag/no artist tag) always writes null.
    const rows = db
      .prepare(
        `SELECT fp.node_id, n.title AS node_title, fp.note, fp.updated_at
         FROM field_provenance fp
         JOIN nodes n ON n.id = fp.node_id
         WHERE fp.field = 'mbid' AND fp.value IS NULL
           AND fp.id = (
             SELECT MAX(fp2.id) FROM field_provenance fp2
             WHERE fp2.node_id = fp.node_id AND fp2.field = 'mbid'
           )`,
      )
      .all() as { node_id: number; node_title: string; note: string | null; updated_at: string }[];
    for (const r of rows) {
      items.push({
        type: "enrichment_flag",
        nodeId: r.node_id,
        nodeTitle: r.node_title,
        note: r.note,
        updatedAt: r.updated_at,
      });
    }
  }

  if (!typeFilter || typeFilter === "missing_file") {
    const rows = db
      .prepare(
        `SELECT f.id AS file_id, f.file_path, n.id AS node_id, n.title AS node_title, f.missing_since
         FROM files f JOIN nodes n ON n.id = f.recording_node_id
         WHERE f.missing_since IS NOT NULL`,
      )
      .all() as { file_id: number; file_path: string; node_id: number; node_title: string; missing_since: string }[];
    for (const r of rows) {
      items.push({
        type: "missing_file",
        fileId: r.file_id,
        filePath: r.file_path,
        nodeId: r.node_id,
        nodeTitle: r.node_title,
        missingSince: r.missing_since,
      });
    }
  }

  return items;
}
