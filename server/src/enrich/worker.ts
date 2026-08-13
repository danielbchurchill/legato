import type Database from "better-sqlite3";
import { searchRecording } from "./mbClient.js";
import { looksSuspicious } from "./sanityCheck.js";
import { pickBestMatch } from "./textSearch.js";

const MAX_BACKOFF_SECONDS = 5 * 60;

type EnrichJob = { id: number; node_id: number; attempts: number };

function getNextDueJob(db: Database.Database): EnrichJob | undefined {
  return db
    .prepare(
      `SELECT id, node_id, attempts FROM enrich_jobs
       WHERE status IN ('queued','error') AND next_attempt_at <= datetime('now')
       ORDER BY priority DESC, id ASC
       LIMIT 1`,
    )
    .get() as EnrichJob | undefined;
}

function getSearchInput(
  db: Database.Database,
  nodeId: number,
): { title: string; artist: string; durationMs: number | null } | null {
  const node = db.prepare("SELECT title FROM nodes WHERE id = ?").get(nodeId) as { title: string } | undefined;
  if (!node) return null;

  const file = db
    .prepare("SELECT tags_raw FROM files WHERE recording_node_id = ? ORDER BY id LIMIT 1")
    .get(nodeId) as { tags_raw: string | null } | undefined;
  const tags = file?.tags_raw ? (JSON.parse(file.tags_raw) as { artist?: string | null }) : null;
  if (!tags?.artist) return null;

  const recording = db.prepare("SELECT canonical_duration_ms FROM recordings WHERE node_id = ?").get(nodeId) as
    | { canonical_duration_ms: number | null }
    | undefined;

  return { title: node.title, artist: tags.artist, durationMs: recording?.canonical_duration_ms ?? null };
}

function recordProvenance(
  db: Database.Database,
  nodeId: number,
  value: string | null,
  confidence: number,
  note: string | null,
): void {
  db.prepare(
    "INSERT INTO field_provenance (node_id, field, value, source, confidence, note) VALUES (?, 'mbid', ?, 'musicbrainz', ?, ?)",
  ).run(nodeId, value, confidence, note);
}

// Mirrors tier 1's local-mbid collapse (match/collapse.ts) but keyed by an
// enrichment-discovered mbid instead of one already embedded in tags: if a
// node already canonical for this mbid exists, repoint every file
// currently on this node to it; otherwise this node becomes canonical.
function applyMatch(db: Database.Database, nodeId: number, mbid: string, confidence: number): void {
  const canonical = db
    .prepare("SELECT id FROM nodes WHERE type = 'recording' AND mbid = ? AND id != ?")
    .get(mbid, nodeId) as { id: number } | undefined;

  if (canonical) {
    db.prepare(
      "UPDATE files SET recording_node_id = ?, match_source = 'mbid', match_confidence = ? WHERE recording_node_id = ?",
    ).run(canonical.id, confidence, nodeId);
  } else {
    db.prepare("UPDATE nodes SET mbid = ?, updated_at = datetime('now') WHERE id = ?").run(mbid, nodeId);
    db.prepare("UPDATE files SET match_source = 'mbid', match_confidence = ? WHERE recording_node_id = ?").run(
      confidence,
      nodeId,
    );
  }

  recordProvenance(db, nodeId, mbid, confidence, null);
}

async function processJob(db: Database.Database, job: EnrichJob): Promise<void> {
  db.prepare("UPDATE enrich_jobs SET status = 'running', updated_at = datetime('now') WHERE id = ?").run(job.id);

  try {
    const input = getSearchInput(db, job.node_id);
    if (!input) {
      // No artist tag to search with at all — not a transient failure,
      // nothing will change on retry.
      recordProvenance(db, job.node_id, null, 0, "no local artist tag to search with");
      db.prepare("UPDATE enrich_jobs SET status = 'done', updated_at = datetime('now') WHERE id = ?").run(job.id);
      return;
    }

    if (looksSuspicious(input.title) || looksSuspicious(input.artist)) {
      recordProvenance(db, job.node_id, null, 0, "tag looks malformed — skipped search, needs a hygiene fix first");
      db.prepare("UPDATE enrich_jobs SET status = 'done', updated_at = datetime('now') WHERE id = ?").run(job.id);
      return;
    }

    const candidates = await searchRecording(input.artist, input.title);
    const result = pickBestMatch(candidates, input.durationMs);

    if (result.outcome === "matched") {
      applyMatch(db, job.node_id, result.mbid, result.confidence);
    } else if (result.outcome === "ambiguous") {
      recordProvenance(
        db,
        job.node_id,
        null,
        0,
        `ambiguous — ${result.candidates.length} tied candidates, needs manual confirmation: ${result.candidates
          .map((c) => c.mbid)
          .join(", ")}`,
      );
    } else {
      recordProvenance(db, job.node_id, null, 0, "no MusicBrainz match found");
    }

    db.prepare("UPDATE enrich_jobs SET status = 'done', updated_at = datetime('now') WHERE id = ?").run(job.id);
  } catch (err) {
    // Network/API failures are transient — back off and retry, unlike the
    // terminal outcomes above (suspicious/ambiguous/no_match are real
    // answers, not errors).
    const message = err instanceof Error ? err.message : String(err);
    const attempts = job.attempts + 1;
    const backoffSeconds = Math.min(2 ** attempts, MAX_BACKOFF_SECONDS);
    // Computed via SQLite's own datetime() rather than JS's toISOString()
    // — the latter produces "2026-01-01T00:00:00.000Z" while SQLite's
    // datetime('now') (used in the due-job WHERE clause) produces
    // "2026-01-01 00:00:00". Those don't compare correctly as TEXT: 'T'
    // (0x54) sorts after a space, so next_attempt_at <= datetime('now')
    // was silently always false and retries never fired. Real bug, caught
    // by actually waiting for a live retry rather than trusting the code.
    db.prepare(
      `UPDATE enrich_jobs SET status = 'error', attempts = ?,
         next_attempt_at = datetime('now', ? || ' seconds'),
         last_error = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(attempts, `+${backoffSeconds}`, message, job.id);
  }
}

let running = false;

// Drains every currently-due job, one at a time (mbClient's own throttle
// enforces the 1req/sec spacing). Safe to call repeatedly/concurrently —
// the `running` guard means overlapping calls (e.g. a poller tick landing
// mid-drain) just no-op instead of double-processing.
export async function runDueJobs(db: Database.Database): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const job = getNextDueJob(db);
      if (!job) break;
      await processJob(db, job);
    }
  } finally {
    running = false;
  }
}
