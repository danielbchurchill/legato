import type Database from "better-sqlite3";

// Auto-queues on scan, gated by one global switch — no per-node consent
// prompts. Missing the setting entirely means enabled: a new library
// should start enriching itself the first time it's scanned, per
// Legato.md's consent model, not wait for an explicit opt-in.
export function isEnrichmentEnabled(db: Database.Database): boolean {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'enrichmentEnabled'").get() as
    | { value: string }
    | undefined;
  return row?.value !== "false";
}

// Only nodes without a confident local mbid actually need a MusicBrainz
// lookup — tier 1 already resolved the rest (match/collapse.ts) without
// spending a rate-limited request. Skips enqueueing a duplicate if one is
// already queued/running for this node.
export function enqueueEnrichmentIfNeeded(db: Database.Database, nodeId: number): void {
  if (!isEnrichmentEnabled(db)) return;

  const file = db.prepare("SELECT match_source FROM files WHERE recording_node_id = ? LIMIT 1").get(nodeId) as
    | { match_source: string }
    | undefined;
  if (file?.match_source === "mbid") return;

  const existing = db
    .prepare("SELECT id FROM enrich_jobs WHERE node_id = ? AND status IN ('queued','running')")
    .get(nodeId);
  if (existing) return;

  db.prepare("INSERT INTO enrich_jobs (node_id, job_type, status) VALUES (?, 'recording_lookup', 'queued')").run(
    nodeId,
  );
}
