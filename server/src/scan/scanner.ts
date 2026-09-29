import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { Database } from "../sqlite.js";
import { recompute } from "../recompute.js";
import { enqueueEnrichmentIfNeeded } from "../enrich/queue.js";
import { attachCoverForFile, type EmbeddedPicture } from "../cover/extract.js";
import { ensurePeaksForFile } from "../waveform/peaks.js";
import { collapseFile } from "../match/collapse.js";
import { deriveLocalEdges } from "../match/edges.js";
import { RateEstimator } from "./rate.js";
import { createProgressGate } from "./throttle.js";
import { parseTags } from "./tags.js";
import { checkLibraryRoot, type CheckOptions } from "./reachability.js";
import { walkLibraryRoot } from "./walk.js";

const HASH_PREFIX_BYTES = 64 * 1024;

async function hashFilePrefix(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha1");
    const stream = createReadStream(filePath, { start: 0, end: HASH_PREFIX_BYTES - 1 });
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

type FileRow = {
  id: number;
  recording_node_id: number;
  file_mtime: string;
  file_size: number;
  missing_since: string | null;
};

export type ScanOutcome = "added" | "updated" | "unchanged";

type ReadTagsResult =
  | { outcome: "unchanged"; fileId: number }
  | { outcome: "added" | "updated"; fileId: number; picture: EmbeddedPicture | null };

// The first half of what used to be scanFile() end to end: stat, diff
// against the existing row, parse tags, and upsert node/recording/file.
// Split out so the multi-stage pipeline (executeScan, below) can run this
// as its own pass over every discovered path — a real 'read_tags' stage
// with its own progress — while scanFile() itself (still used unchanged by
// the watcher and rescanNode, both single-file callers with no stage
// concept) just runs this immediately followed by finishFileMatch().
async function readFileTags(db: Database, libraryRootId: number, filePath: string): Promise<ReadTagsResult> {
  const st = await stat(filePath);
  const mtime = st.mtime.toISOString();

  const existing = db
    .prepare<FileRow>("SELECT id, recording_node_id, file_mtime, file_size, missing_since FROM files WHERE file_path = ?")
    .get(filePath);

  if (existing && existing.file_mtime === mtime && existing.file_size === st.size) {
    if (existing.missing_since) {
      db.prepare("UPDATE files SET missing_since = NULL, last_seen_at = datetime('now') WHERE id = ?").run(
        existing.id,
      );
    } else {
      db.prepare("UPDATE files SET last_seen_at = datetime('now') WHERE id = ?").run(existing.id);
    }
    return { outcome: "unchanged", fileId: existing.id };
  }

  const [parsed, fileHash] = await Promise.all([parseTags(filePath), hashFilePrefix(filePath)]);
  const { tags, picture } = parsed;
  const title = tags.title ?? path.basename(filePath, path.extname(filePath));

  const upsert = db.transaction((): { outcome: ScanOutcome; fileId: number } => {
    if (existing) {
      db.prepare("UPDATE nodes SET title = ?, updated_at = datetime('now') WHERE id = ?").run(
        title,
        existing.recording_node_id,
      );
      db.prepare("UPDATE recordings SET canonical_duration_ms = ? WHERE node_id = ?").run(
        tags.durationMs,
        existing.recording_node_id,
      );
      db.prepare(
        `UPDATE files SET
           format = ?, duration_ms = ?, bitrate = ?, sample_rate = ?, channels = ?,
           replaygain_track_gain = ?, replaygain_album_gain = ?,
           track_no = ?, disc_no = ?, release_date = ?, bpm = ?, label = ?, release_type = ?, genre = ?,
           file_mtime = ?, file_size = ?, file_hash = ?,
           last_seen_at = datetime('now'), missing_since = NULL, tags_raw = ?
         WHERE id = ?`,
      ).run(
        tags.format,
        tags.durationMs,
        tags.bitrate,
        tags.sampleRate,
        tags.channels,
        tags.replaygainTrackGain,
        tags.replaygainAlbumGain,
        tags.trackNo,
        tags.discNo,
        tags.releaseDate,
        tags.bpm,
        tags.label,
        tags.releaseType,
        tags.genre ? JSON.stringify(tags.genre) : null,
        mtime,
        st.size,
        fileHash,
        JSON.stringify(tags),
        existing.id,
      );
      return { outcome: "updated", fileId: existing.id };
    }

    const node = db
      .prepare("INSERT INTO nodes (type, title) VALUES ('recording', ?) RETURNING id")
      .get(title) as { id: number };
    db.prepare("INSERT INTO recordings (node_id, canonical_duration_ms) VALUES (?, ?)").run(
      node.id,
      tags.durationMs,
    );
    const insertedFile = db
      .prepare(
        `INSERT INTO files (
           recording_node_id, library_root_id, file_path,
           format, duration_ms, bitrate, sample_rate, channels,
           replaygain_track_gain, replaygain_album_gain,
           track_no, disc_no, release_date, bpm, label, release_type, genre,
           file_mtime, file_size, file_hash, tags_raw
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        node.id,
        libraryRootId,
        filePath,
        tags.format,
        tags.durationMs,
        tags.bitrate,
        tags.sampleRate,
        tags.channels,
        tags.replaygainTrackGain,
        tags.replaygainAlbumGain,
        tags.trackNo,
        tags.discNo,
        tags.releaseDate,
        tags.bpm,
        tags.label,
        tags.releaseType,
        tags.genre ? JSON.stringify(tags.genre) : null,
        mtime,
        st.size,
        fileHash,
        JSON.stringify(tags),
      ) as { id: number };
    return { outcome: "added", fileId: insertedFile.id };
  });

  const { outcome, fileId } = upsert();
  return { outcome, fileId, picture };
}

// The second half of the old scanFile(): match, collapse, enqueue for
// enrichment, and the two best-effort side jobs (cover art, waveform
// peaks). Order matters — attachCoverForFile runs after deriveLocalEdges
// so the release node this file belongs to already exists.
async function finishFileMatch(
  db: Database,
  fileId: number,
  filePath: string,
  picture: EmbeddedPicture | null,
  onWarn: (message: string) => void,
): Promise<void> {
  await collapseFile(db, fileId);
  deriveLocalEdges(db, fileId);

  const { recording_node_id: currentNodeId } = db
    .prepare("SELECT recording_node_id FROM files WHERE id = ?")
    .get(fileId) as { recording_node_id: number };
  enqueueEnrichmentIfNeeded(db, currentNodeId);

  try {
    await attachCoverForFile(db, { id: fileId, path: filePath, recordingNodeId: currentNodeId }, picture);
  } catch (err) {
    onWarn(`cover art failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    await ensurePeaksForFile(db, fileId);
  } catch (err) {
    onWarn(`waveform peaks failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Diffs a single file against its existing DB row (if any) and upserts —
// the one code path shared by both a full walk-based scan and a single
// chokidar event, so "a tag edit re-scans just that file" and "a full scan
// skips untouched files" are the same guarantee, not two implementations.
// Unchanged in shape and order since #123: still one atomic pass for a
// single file (the watcher and rescanNode have no use for a multi-stage
// checkpoint), now composed from readFileTags()/finishFileMatch() so the
// batched multi-file pipeline below can run the same two halves as
// separate stages instead.
export async function scanFile(
  db: Database,
  libraryRootId: number,
  filePath: string,
  // Non-fatal problems (currently only cover art) surface here rather than
  // being thrown or silently dropped. Defaulted so every existing caller and
  // every test keeps working unchanged.
  onWarn: (message: string) => void = (message) => console.warn(message),
): Promise<ScanOutcome> {
  const result = await readFileTags(db, libraryRootId, filePath);
  if (result.outcome === "unchanged") return "unchanged";
  await finishFileMatch(db, result.fileId, filePath, result.picture, onWarn);
  return result.outcome;
}

// Marks a file missing without deleting it — vanished files preserve their
// node/edge/play history rather than losing it, same don't-destroy-data
// bias as merge_overrides. Idempotent: a file already marked missing stays
// at its original missing_since timestamp.
export function markMissing(db: Database, filePath: string): void {
  db.prepare(
    "UPDATE files SET missing_since = datetime('now') WHERE file_path = ? AND missing_since IS NULL",
  ).run(filePath);
}

export type RescanFileResult =
  | { fileId: number; filePath: string; outcome: ScanOutcome | "missing" }
  | { fileId: number; filePath: string; error: string };

// Tag Manager's per-row "rescan" action (issue #65) — the same scanFile()
// short-circuit/re-derive path the filesystem watcher already runs per
// changed file, aimed at a node instead of a path so the route only needs
// a node id. A recording can have more than one file (a merge — see
// InstancesList in MetadataFields.tsx); every one of them is rescanned,
// not just the first. Never throws per-file: a file gone missing since its
// row was written is recorded via markMissing() exactly like the watcher's
// own 'unlink' handler, and any other failure is captured in the result
// list instead of aborting the rest of the node's files.
export async function rescanNode(db: Database, nodeId: number): Promise<RescanFileResult[]> {
  const files = db
    .prepare("SELECT id, library_root_id, file_path FROM files WHERE recording_node_id = ?")
    .all(nodeId) as { id: number; library_root_id: number; file_path: string }[];

  const results: RescanFileResult[] = [];
  for (const file of files) {
    try {
      const outcome = await scanFile(db, file.library_root_id, file.file_path);
      results.push({ fileId: file.id, filePath: file.file_path, outcome });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        markMissing(db, file.file_path);
        results.push({ fileId: file.id, filePath: file.file_path, outcome: "missing" });
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      results.push({ fileId: file.id, filePath: file.file_path, error: message });
    }
  }

  return results;
}

// Issue #123 (D17): the pipeline a full/incremental scan actually walks
// through, in order. 'discover' is the filesystem walk; the middle four
// are each a full pass over every file this run touches, in this order,
// because deriveLocalEdges ('collapse') has to run before a file's cover
// art can attach to the right release node, and enqueueEnrichmentIfNeeded
// ('enrich_queued') only makes sense once match_source is final.
export const SCAN_STAGES = ["discover", "read_tags", "match", "collapse", "layout", "enrich_queued"] as const;
export type ScanStage = (typeof SCAN_STAGES)[number];

export type ScanProgress = {
  jobId: number;
  libraryRootId: number;
  stage: ScanStage;
  stageDone: number;
  stageTotal: number | null;
  // Back-compat with every consumer that predates stages (LibrarySetup.tsx,
  // LegatoSettings.tsx, useScanStatus.ts): filesScanned/filesTotal keep
  // meaning exactly what they always did — how far through 'read_tags' the
  // run is — and simply hold at filesTotal/filesTotal once later stages
  // (match/collapse/layout/enrich_queued) take over as 'stage'.
  filesScanned: number;
  filesTotal: number;
  filesAdded: number;
  filesUpdated: number;
  // null means "estimating..." — see rate.ts's RateEstimator.
  rate: number | null;
  etaSeconds: number | null;
};

export type ScanMode = "full" | "incremental";

type ScanJobRow = {
  id: number;
  library_root_id: number;
  status: string;
  mode: ScanMode;
  stage: ScanStage;
  cursor: number;
  files_scanned: number;
  files_added: number;
  files_updated: number;
  files_missing: number;
};

function loadJob(db: Database, jobId: number): ScanJobRow {
  const row = db.prepare<ScanJobRow>("SELECT * FROM scan_jobs WHERE id = ?").get(jobId);
  if (!row) throw new Error(`scan job ${jobId} not found`);
  return row;
}

// In-memory only, on purpose: a pause/cancel request only ever needs to
// reach a scan loop that is actually running in *this* process. A run
// still 'running' in the DB with nothing live here (the server restarted
// mid-scan) is reconciled to 'paused' at boot instead — see
// reconcileInterruptedScans — so there's never a live loop elsewhere this
// map would need to reach.
const controlSignals = new Map<number, "pause" | "cancel">();

export function requestPauseScanJob(db: Database, jobId: number): { ok: true } | { ok: false; error: string } {
  const job = db.prepare<{ status: string }>("SELECT status FROM scan_jobs WHERE id = ?").get(jobId);
  if (!job) return { ok: false, error: "scan job not found" };
  if (job.status !== "running") return { ok: false, error: `cannot pause a job with status '${job.status}'` };
  controlSignals.set(jobId, "pause");
  return { ok: true };
}

// Cancel has two shapes: a *running* job is signalled the same way pause
// is (the live loop notices, finalizes, and cleans up after itself once it
// stops between files). A *paused* job has no live loop to signal — there's
// nothing to interrupt — so this finalizes it directly instead.
export function requestCancelScanJob(
  db: Database,
  jobId: number,
): { ok: true; finalizedNow: boolean } | { ok: false; error: string } {
  const job = db.prepare<{ status: string }>("SELECT status FROM scan_jobs WHERE id = ?").get(jobId);
  if (!job) return { ok: false, error: "scan job not found" };
  if (job.status === "running") {
    controlSignals.set(jobId, "cancel");
    return { ok: true, finalizedNow: false };
  }
  if (job.status === "paused") {
    db.prepare(
      "UPDATE scan_jobs SET status = 'canceled', canceled_at = datetime('now'), finished_at = datetime('now') WHERE id = ?",
    ).run(jobId);
    cleanupScanRunFiles(db, jobId);
    return { ok: true, finalizedNow: true };
  }
  return { ok: false, error: `cannot cancel a job with status '${job.status}'` };
}

function cleanupScanRunFiles(db: Database, jobId: number): void {
  db.prepare("DELETE FROM scan_run_files WHERE job_id = ?").run(jobId);
}

function recordFileError(db: Database, jobId: number, filePath: string, stage: ScanStage, reason: string): void {
  db.prepare("INSERT INTO scan_file_errors (job_id, file_path, stage, reason) VALUES (?, ?, ?, ?)").run(
    jobId,
    filePath,
    stage,
    reason,
  );
}

function persistCursor(db: Database, jobId: number, stage: ScanStage, cursor: number): void {
  db.prepare("UPDATE scan_jobs SET stage = ?, cursor = ? WHERE id = ?").run(stage, cursor, jobId);
}

const INSERT_CHUNK = 2000;

// Batched on purpose (CLAUDE.md's "batch writes" scale note, and the plan
// doc's own "It has to feel normal at 180k files"): one transaction per
// chunk rather than one INSERT per file, and one transaction per run
// rather than one giant statement that would need every bound parameter
// held at once.
function insertScanRunFiles(db: Database, jobId: number, paths: string[]): void {
  const insert = db.prepare("INSERT INTO scan_run_files (job_id, seq, file_path) VALUES (?, ?, ?)");
  const insertChunk = db.transaction((chunk: string[], startSeq: number) => {
    chunk.forEach((p, i) => insert.run(jobId, startSeq + i, p));
  });
  for (let i = 0; i < paths.length; i += INSERT_CHUNK) {
    insertChunk(paths.slice(i, i + INSERT_CHUNK), i);
  }
}

type ScanRunFileRow = {
  seq: number;
  file_path: string;
  file_id: number | null;
  outcome: "added" | "updated" | "unchanged" | "error" | null;
  picture_data: Uint8Array | null;
  picture_mime: string | null;
};

const PAGE_SIZE = 500;
// How often (in files) a stage persists its cursor mid-run — bounds
// checkpoint writes to a couple hundred over a 100k-file stage rather than
// one per file, while still keeping a resume within a small multiple of
// this many files' rework of whatever it repeats.
const CHECKPOINT_EVERY = 50;
// ~4/s per the plan doc's throttling requirement.
const PROGRESS_THROTTLE_MS = 250;

type StageOutcome = "completed" | "pause" | "cancel";

function fetchPage(db: Database, jobId: number, fromSeq: number): ScanRunFileRow[] {
  return db
    .prepare<ScanRunFileRow>(
      `SELECT seq, file_path, file_id, outcome, picture_data, picture_mime
         FROM scan_run_files WHERE job_id = ? AND seq >= ? ORDER BY seq LIMIT ?`,
    )
    .all(jobId, fromSeq, PAGE_SIZE);
}

// The 'read_tags' stage: the only one that *writes* scan_run_files rather
// than just reading them back — it's what decides each file's outcome
// (added/updated/unchanged/error) and, for a file the later 'enrich_queued'
// stage will need it for, stashes its embedded cover picture in the same
// row rather than an in-memory array (see the migration's comment on why).
async function runReadTagsStage(
  db: Database,
  job: ScanJobRow,
  startCursor: number,
  libraryRootId: number,
  onCount: (outcome: "added" | "updated") => void,
  emit: (done: number, force?: boolean) => void,
): Promise<StageOutcome> {
  let cursor = startCursor;
  emit(cursor, true);

  for (;;) {
    const rows = fetchPage(db, job.id, cursor);
    if (rows.length === 0) break;

    for (const row of rows) {
      const signal = controlSignals.get(job.id);
      if (signal) {
        persistCursor(db, job.id, "read_tags", cursor);
        return signal;
      }

      try {
        const result = await readFileTags(db, libraryRootId, row.file_path);
        if (result.outcome === "unchanged") {
          db.prepare("UPDATE scan_run_files SET outcome = 'unchanged' WHERE job_id = ? AND seq = ?").run(
            job.id,
            row.seq,
          );
        } else {
          db.prepare(
            "UPDATE scan_run_files SET file_id = ?, outcome = ?, picture_data = ?, picture_mime = ? WHERE job_id = ? AND seq = ?",
          ).run(
            result.fileId,
            result.outcome,
            result.picture?.data ?? null,
            result.picture?.mime ?? null,
            job.id,
            row.seq,
          );
          onCount(result.outcome);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        db.prepare("UPDATE scan_run_files SET outcome = 'error' WHERE job_id = ? AND seq = ?").run(job.id, row.seq);
        recordFileError(db, job.id, row.file_path, "read_tags", message);
      }

      cursor = row.seq + 1;
      // Checkpointing (DB durability, bounding a resume's rework) and
      // progress emission (a client's ~4/s throttled view) are deliberately
      // NOT coupled — a checkpoint every CHECKPOINT_EVERY files can occur
      // far more often than every PROGRESS_THROTTLE_MS at real-world
      // throughput (confirmed on the ≥100k-file synthetic benchmark: 2000+
      // files/sec meant a forced emit every ~25ms, an order of magnitude
      // over the plan doc's "about 4/s"). emit() is still called every
      // file, but un-forced — the gate itself decides whether real wall
      // time has actually passed.
      if (cursor % CHECKPOINT_EVERY === 0) persistCursor(db, job.id, "read_tags", cursor);
      emit(cursor, false);
    }
  }

  persistCursor(db, job.id, "read_tags", cursor);
  emit(cursor, true);
  return "completed";
}

// 'match', 'collapse' and 'enrich_queued' share this shape: read
// scan_run_files back in seq order, skip whatever 'read_tags' (or an
// earlier one of these three) already ruled out, run one per-file action,
// and record — rather than throw — anything that goes wrong so one bad
// file never stops the rest (H9).
async function runFileStage(
  db: Database,
  job: ScanJobRow,
  stage: ScanStage,
  startCursor: number,
  handle: (row: ScanRunFileRow) => Promise<void>,
  emit: (done: number, force?: boolean) => void,
): Promise<StageOutcome> {
  let cursor = startCursor;
  emit(cursor, true);

  for (;;) {
    const rows = fetchPage(db, job.id, cursor);
    if (rows.length === 0) break;

    for (const row of rows) {
      const signal = controlSignals.get(job.id);
      if (signal) {
        persistCursor(db, job.id, stage, cursor);
        return signal;
      }

      if (row.outcome === "added" || row.outcome === "updated") {
        try {
          await handle(row);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          db.prepare("UPDATE scan_run_files SET outcome = 'error' WHERE job_id = ? AND seq = ?").run(job.id, row.seq);
          recordFileError(db, job.id, row.file_path, stage, message);
        }
      }
      // 'unchanged' and already-'error' rows are skipped — nothing to
      // match/collapse/enqueue for a file this run didn't touch or already
      // gave up on — but still counted, so stageDone reaches filesTotal.

      cursor = row.seq + 1;
      // See runReadTagsStage's comment on why a checkpoint no longer forces
      // its progress emission through the throttle gate.
      if (cursor % CHECKPOINT_EVERY === 0) persistCursor(db, job.id, stage, cursor);
      emit(cursor, false);
    }
  }

  persistCursor(db, job.id, stage, cursor);
  emit(cursor, true);
  return "completed";
}

// Not file-granular — recompute() runs once over the whole library, not
// per file — so 'layout' has no real cursor of its own; 0/1 stands in for
// not-started/done, same as everywhere else in this pipeline uses cursor
// for "how far through this stage".
async function runLayoutStage(
  db: Database,
  job: ScanJobRow,
  startCursor: number,
  mode: ScanMode,
  libraryRootId: number,
  guardRoot: (options: CheckOptions) => Promise<boolean>,
  onMissing: (count: number) => void,
  emit: (done: number, force?: boolean) => void,
): Promise<StageOutcome | "unreachable"> {
  if (startCursor >= 1) return "completed";

  const signal = controlSignals.get(job.id);
  if (signal) return signal;

  emit(0, true);

  // The missing-file sweep (full mode only) has always run right before
  // recompute(), not as its own reported stage — it's a couple of set
  // queries, not per-file work proportional to what the plan calls out as
  // needing its own progress.
  if (mode === "full") {
    const seen = new Set(
      (db.prepare<{ file_path: string }>("SELECT file_path FROM scan_run_files WHERE job_id = ?").all(job.id)).map(
        (r) => r.file_path,
      ),
    );
    // Issue #192: checked again here, not just after discover, because a
    // resumed job skips discover entirely and a drive can drop in the
    // hours between a pause and its resume. Everything the sweep is about
    // to mark missing is decided by this one answer.
    if (!(await guardRoot({ audioFilesFound: seen.size }))) return "unreachable";
    const existingPaths = db
      .prepare<{ file_path: string }>(
        "SELECT file_path FROM files WHERE library_root_id = ? AND missing_since IS NULL",
      )
      .all(libraryRootId);
    let missing = 0;
    for (const { file_path } of existingPaths) {
      if (!seen.has(file_path)) {
        markMissing(db, file_path);
        missing++;
      }
    }
    onMissing(missing);
  }

  // B-1: everything derived from what scan found, recomputed
  // unconditionally for every file currently in the library — not just
  // the ones this run changed. Idempotent (see seed.ts's seed_version
  // guard, deriveLocalEdges' delete-then-reinsert) on a no-op re-scan, and
  // still needed after an incremental scan: newly-added files still have
  // to get positions, entity aggregation, and similarity edges to show up
  // in the graph at all.
  recompute(db);

  persistCursor(db, job.id, "layout", 1);
  emit(1, true);
  return "completed";
}

function finalizeInterrupted(db: Database, jobId: number, signal: "pause" | "cancel"): void {
  controlSignals.delete(jobId);
  if (signal === "pause") {
    db.prepare("UPDATE scan_jobs SET status = 'paused', paused_at = datetime('now') WHERE id = ?").run(jobId);
  } else {
    db.prepare(
      "UPDATE scan_jobs SET status = 'canceled', canceled_at = datetime('now'), finished_at = datetime('now') WHERE id = ?",
    ).run(jobId);
    cleanupScanRunFiles(db, jobId);
  }
}

// Split in two so an HTTP caller can get a job id back immediately instead
// of blocking the request for however long the whole walk takes:
// createScanJob() is a single fast synchronous insert, executeScan() is the
// long-running part a route handler fires-and-forgets while the client
// polls GET /api/v1/scan-jobs/:id for status.
export function createScanJob(db: Database, libraryRootId: number, mode: ScanMode = "full"): number {
  const job = db
    .prepare("INSERT INTO scan_jobs (library_root_id, status, mode) VALUES (?, 'running', ?) RETURNING id")
    .get(libraryRootId, mode) as { id: number };
  return job.id;
}

// Issue #123 (D17): resume-aware by construction rather than a separate
// "resumeScan" code path — every call re-reads the job's persisted
// stage/cursor before doing anything, so a fresh job (stage='discover',
// cursor=0, the columns' own DB defaults) and a job resumeScanJob() just
// flipped back to 'running' after a pause take exactly the same route
// through this function. Issue #28's mode behavior (full vs incremental
// diffing against known files) is preserved untouched — it only affects
// what 'discover' hands to 'read_tags', nothing past that.
export async function executeScan(
  db: Database,
  jobId: number,
  libraryRootId: number,
  rootPath: string,
  onProgress?: (progress: ScanProgress) => void,
  mode: ScanMode = "full",
  // Injectable, same pattern as rate.ts/throttle.ts — the throttle gate
  // below decides every emit's fate off of this clock. Real scans never
  // pass it; tests do, so a synthetic run that finishes in milliseconds of
  // wall-clock time can still deterministically exercise the ~4/s gate
  // instead of only ever seeing a stage's forced start/end emits.
  nowFn: () => number = Date.now,
): Promise<void> {
  controlSignals.delete(jobId);

  let job = loadJob(db, jobId);
  let filesAdded = job.files_added;
  let filesUpdated = job.files_updated;
  let filesScanned = job.files_scanned;
  let filesMissing = job.files_missing;

  // Issue #192: a root that isn't reachable ends the run here, as an
  // error carrying the H9 message, instead of letting a walk that found
  // nothing (the drive is gone, not the music) reach the missing-file
  // sweep. Nothing past this point writes anything, so stopping is safe
  // at every call site, and the run's scan_run_files go the same way a
  // cancel's do.
  const guardRoot = async (options: CheckOptions): Promise<boolean> => {
    const result = await checkLibraryRoot(db, libraryRootId, rootPath, options);
    if (result.reachable) return true;
    db.prepare(
      "UPDATE scan_jobs SET status = 'error', error_message = ?, finished_at = datetime('now') WHERE id = ?",
    ).run(result.message, jobId);
    cleanupScanRunFiles(db, jobId);
    controlSignals.delete(jobId);
    return false;
  };

  try {
    // Before the walk, stat-level checks only: a hard-mounted NFS share
    // with its server gone would otherwise hang the walk itself, and the
    // check has a timeout where fast-glob has none.
    if (!(await guardRoot({ skipEmptyCheck: true }))) return;

    if (job.stage === "discover") {
      const paths = await walkLibraryRoot(rootPath);

      // After it, before anything is read or written: an empty walk over a
      // root the DB still has live files under is the drive, not the music.
      // Incremental mode gets this too even though it has no sweep — the
      // same unmounted mount point would otherwise have whatever happens to
      // sit in the bare directory underneath read in as new library files.
      if (!(await guardRoot({ audioFilesFound: paths.length }))) return;

      let pathsToScan = paths;
      if (mode === "incremental") {
        const known = new Set(
          (
            db.prepare("SELECT file_path FROM files WHERE library_root_id = ?").all(libraryRootId) as {
              file_path: string;
            }[]
          ).map((row) => row.file_path),
        );
        pathsToScan = paths.filter((filePath) => !known.has(filePath));
      }

      insertScanRunFiles(db, jobId, pathsToScan);
      db.prepare("UPDATE scan_jobs SET stage = 'read_tags', cursor = 0 WHERE id = ?").run(jobId);
      job = loadJob(db, jobId);

      const signal = controlSignals.get(jobId);
      if (signal) {
        finalizeInterrupted(db, jobId, signal);
        return;
      }
    }

    const { count: filesTotal } = db
      .prepare<{ count: number }>("SELECT COUNT(*) AS count FROM scan_run_files WHERE job_id = ?")
      .get(jobId) as { count: number };

    const gate = createProgressGate(PROGRESS_THROTTLE_MS, nowFn);
    const rateEstimator = new RateEstimator();

    function emitFor(stage: ScanStage, stageTotal: number | null) {
      return (done: number, force = false) => {
        if (!onProgress || !gate(force)) return;
        const now = nowFn();
        rateEstimator.sample(done, now);
        onProgress({
          jobId,
          libraryRootId,
          stage,
          stageDone: done,
          stageTotal,
          filesScanned,
          filesTotal,
          filesAdded,
          filesUpdated,
          rate: rateEstimator.rate(now),
          etaSeconds: stageTotal === null ? null : rateEstimator.etaSeconds(stageTotal - done, now),
        });
      };
    }

    const resumeStage = job.stage;
    const resumeCursor = job.cursor;
    const stagesFromHere = SCAN_STAGES.slice(SCAN_STAGES.indexOf(resumeStage));

    for (const stage of stagesFromHere) {
      if (stage === "discover") continue; // handled above, always complete by this point
      rateEstimator.reset();
      const startCursor = stage === resumeStage ? resumeCursor : 0;

      let outcome: StageOutcome;
      if (stage === "read_tags") {
        outcome = await runReadTagsStage(
          db,
          job,
          startCursor,
          libraryRootId,
          (fileOutcome) => {
            if (fileOutcome === "added") filesAdded++;
            else filesUpdated++;
          },
          (done, force) => {
            filesScanned = done;
            db.prepare("UPDATE scan_jobs SET files_scanned = ?, files_added = ?, files_updated = ? WHERE id = ?").run(
              filesScanned,
              filesAdded,
              filesUpdated,
              jobId,
            );
            emitFor("read_tags", filesTotal)(done, force);
          },
        );
      } else if (stage === "match") {
        outcome = await runFileStage(
          db,
          job,
          "match",
          startCursor,
          async (row) => {
            await collapseFile(db, row.file_id as number);
          },
          emitFor("match", filesTotal),
        );
      } else if (stage === "collapse") {
        outcome = await runFileStage(
          db,
          job,
          "collapse",
          startCursor,
          // eslint-disable-next-line @typescript-eslint/require-await
          async (row) => {
            deriveLocalEdges(db, row.file_id as number);
          },
          emitFor("collapse", filesTotal),
        );
      } else if (stage === "layout") {
        const layoutOutcome = await runLayoutStage(
          db,
          job,
          startCursor,
          mode,
          libraryRootId,
          guardRoot,
          (missing) => {
            filesMissing = missing;
            db.prepare("UPDATE scan_jobs SET files_missing = ? WHERE id = ?").run(filesMissing, jobId);
          },
          emitFor("layout", 1),
        );
        if (layoutOutcome === "unreachable") return;
        outcome = layoutOutcome;
      } else {
        outcome = await runFileStage(
          db,
          job,
          "enrich_queued",
          startCursor,
          async (row) => {
            const fileId = row.file_id as number;
            const { recording_node_id: nodeId } = db
              .prepare("SELECT recording_node_id FROM files WHERE id = ?")
              .get(fileId) as { recording_node_id: number };
            enqueueEnrichmentIfNeeded(db, nodeId);
            const picture: EmbeddedPicture | null = row.picture_data
              ? { data: Buffer.from(row.picture_data), mime: row.picture_mime }
              : null;
            try {
              await attachCoverForFile(db, { id: fileId, path: row.file_path, recordingNodeId: nodeId }, picture);
            } catch (err) {
              recordFileError(
                db,
                jobId,
                row.file_path,
                "enrich_queued",
                `cover art failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
            try {
              await ensurePeaksForFile(db, fileId);
            } catch (err) {
              recordFileError(
                db,
                jobId,
                row.file_path,
                "enrich_queued",
                `waveform peaks failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          },
          emitFor("enrich_queued", filesTotal),
        );
      }

      if (outcome !== "completed") {
        finalizeInterrupted(db, jobId, outcome);
        return;
      }
      job = loadJob(db, jobId);
    }

    db.prepare("UPDATE scan_jobs SET status = 'done', finished_at = datetime('now') WHERE id = ?").run(jobId);
    cleanupScanRunFiles(db, jobId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    db.prepare(
      "UPDATE scan_jobs SET status = 'error', error_message = ?, finished_at = datetime('now') WHERE id = ?",
    ).run(message, jobId);
    controlSignals.delete(jobId);
  }
}

// A server that died mid-scan (a crash, a forced restart — not a
// deliberate pause) leaves a scan_jobs row stuck at status='running' with
// no process left actually running it. Called once at boot: any such row
// becomes 'paused' instead, which is both honest (nothing is running) and
// exactly the state a deliberate pause would have left it in — same
// resume path either way, and the plan's "pause survives a server
// restart" guarantee holds even for a restart nobody asked for.
export function reconcileInterruptedScans(db: Database): number {
  const stuck = db.prepare<{ id: number }>("SELECT id FROM scan_jobs WHERE status = 'running'").all();
  if (stuck.length > 0) {
    db.prepare("UPDATE scan_jobs SET status = 'paused', paused_at = datetime('now') WHERE status = 'running'").run();
  }
  return stuck.length;
}

// The other half of requestPauseScanJob(): actually re-enters executeScan
// for a paused job, which (being resume-aware by construction — see
// executeScan's own comment) just continues from its persisted
// stage/cursor without needing a separate resume implementation.
export async function resumeScanJob(
  db: Database,
  jobId: number,
  onProgress?: (progress: ScanProgress) => void,
): Promise<void> {
  const job = db
    .prepare<{ status: string; library_root_id: number; mode: ScanMode }>(
      "SELECT status, library_root_id, mode FROM scan_jobs WHERE id = ?",
    )
    .get(jobId);
  if (!job) throw new Error(`scan job ${jobId} not found`);
  if (job.status !== "paused") throw new Error(`cannot resume a job with status '${job.status}'`);

  const root = db.prepare<{ path: string }>("SELECT path FROM library_roots WHERE id = ?").get(job.library_root_id);
  if (!root) throw new Error(`library root ${job.library_root_id} not found`);

  controlSignals.delete(jobId);
  db.prepare("UPDATE scan_jobs SET status = 'running', paused_at = NULL WHERE id = ?").run(jobId);
  await executeScan(db, jobId, job.library_root_id, root.path, onProgress, job.mode);
}

// Convenience for callers that want to await full completion (tests, and
// chaining "scan, then start watching" on library-root creation) rather
// than fire-and-forget an HTTP response.
export async function runFullScan(
  db: Database,
  libraryRootId: number,
  rootPath: string,
  onProgress?: (progress: ScanProgress) => void,
): Promise<number> {
  const jobId = createScanJob(db, libraryRootId, "full");
  await executeScan(db, jobId, libraryRootId, rootPath, onProgress, "full");
  return jobId;
}

// Same shape as runFullScan, for callers (tests, and POST /scan's
// mode: "incremental") that want to await a whole incremental run rather
// than poll a job id.
export async function runIncrementalScan(
  db: Database,
  libraryRootId: number,
  rootPath: string,
  onProgress?: (progress: ScanProgress) => void,
): Promise<number> {
  const jobId = createScanJob(db, libraryRootId, "incremental");
  await executeScan(db, jobId, libraryRootId, rootPath, onProgress, "incremental");
  return jobId;
}
