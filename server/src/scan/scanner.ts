import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3";
import { recompute } from "../recompute.js";
import { enqueueEnrichmentIfNeeded } from "../enrich/queue.js";
import { attachCoverForFile } from "../cover/extract.js";
import { ensurePeaksForFile } from "../waveform/peaks.js";
import { collapseFile } from "../match/collapse.js";
import { deriveLocalEdges } from "../match/edges.js";
import { parseTags } from "./tags.js";
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

// Diffs a single file against its existing DB row (if any) and upserts —
// the one code path shared by both a full walk-based scan and a single
// chokidar event, so "a tag edit re-scans just that file" and "a full scan
// skips untouched files" are the same guarantee, not two implementations.
export async function scanFile(
  db: Database.Database,
  libraryRootId: number,
  filePath: string,
  // Non-fatal problems (currently only cover art) surface here rather than
  // being thrown or silently dropped. Defaulted so every existing caller and
  // every test keeps working unchanged.
  onWarn: (message: string) => void = (message) => console.warn(message),
): Promise<ScanOutcome> {
  const st = await stat(filePath);
  const mtime = st.mtime.toISOString();

  const existing = db
    .prepare("SELECT id, recording_node_id, file_mtime, file_size, missing_since FROM files WHERE file_path = ?")
    .get(filePath) as FileRow | undefined;

  if (existing && existing.file_mtime === mtime && existing.file_size === st.size) {
    if (existing.missing_since) {
      db.prepare("UPDATE files SET missing_since = NULL, last_seen_at = datetime('now') WHERE id = ?").run(
        existing.id,
      );
    } else {
      db.prepare("UPDATE files SET last_seen_at = datetime('now') WHERE id = ?").run(existing.id);
    }
    return "unchanged";
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

  // Matching (collapse + hard-edge derivation) runs outside the write
  // transaction — tier 2 shells out to fpcalc, which has no business
  // holding a SQLite write lock open while it waits on a child process.
  await collapseFile(db, fileId);
  deriveLocalEdges(db, fileId);

  const { recording_node_id: currentNodeId } = db
    .prepare("SELECT recording_node_id FROM files WHERE id = ?")
    .get(fileId) as { recording_node_id: number };
  enqueueEnrichmentIfNeeded(db, currentNodeId);

  // After deriveLocalEdges, so the release node this file belongs to exists
  // and the art can attach to the album rather than to each track. Failure
  // here is never fatal: a corrupt embedded image or an unreadable folder
  // costs the album its artwork, not the file its place in the library.
  try {
    await attachCoverForFile(
      db,
      { id: fileId, path: filePath, recordingNodeId: currentNodeId },
      picture,
    );
  } catch (err) {
    onWarn(`cover art failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Same inline, non-fatal shape as cover art immediately above — a
  // failed decode costs the track its waveform, not its place in the
  // library. isCached() inside ensurePeaksForFile keeps a no-op re-scan
  // cheap (no ffmpeg spawn for a file already covered).
  try {
    await ensurePeaksForFile(db, fileId);
  } catch (err) {
    onWarn(`waveform peaks failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  return outcome;
}

// Marks a file missing without deleting it — vanished files preserve their
// node/edge/play history rather than losing it, same don't-destroy-data
// bias as merge_overrides. Idempotent: a file already marked missing stays
// at its original missing_since timestamp.
export function markMissing(db: Database.Database, filePath: string): void {
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
export async function rescanNode(db: Database.Database, nodeId: number): Promise<RescanFileResult[]> {
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

export type ScanProgress = {
  jobId: number;
  libraryRootId: number;
  filesScanned: number;
  filesTotal: number;
  filesAdded: number;
  filesUpdated: number;
};

export type ScanMode = "full" | "incremental";

// Split in two so an HTTP caller can get a job id back immediately instead
// of blocking the request for however long the whole walk takes:
// createScanJob() is a single fast synchronous insert, executeScan() is the
// long-running part a route handler fires-and-forgets while the client
// polls GET /api/v1/scan-jobs/:id for status.
export function createScanJob(
  db: Database.Database,
  libraryRootId: number,
  mode: ScanMode = "full",
): number {
  const job = db
    .prepare("INSERT INTO scan_jobs (library_root_id, status, mode) VALUES (?, 'running', ?) RETURNING id")
    .get(libraryRootId, mode) as { id: number };
  return job.id;
}

// Issue #28: on a large library, a 'full' rescan pays a stat() + two tiny
// queries for every file already known to the DB just to confirm nothing
// changed (see scanFile's unchanged-mtime/size short-circuit). 'incremental'
// skips that entirely — it diffs the walk against files.file_path for this
// root using nothing but a Set (no per-known-file I/O) and only calls
// scanFile on paths the DB has never seen. It deliberately never touches an
// already-known row: no missing-file sweep either, since that writes
// missing_since onto rows this mode is promising not to touch. A file that
// moved, was edited, or vanished is still 'full' rescan's job.
export async function executeScan(
  db: Database.Database,
  jobId: number,
  libraryRootId: number,
  rootPath: string,
  onProgress?: (progress: ScanProgress) => void,
  mode: ScanMode = "full",
): Promise<void> {
  let filesScanned = 0;
  let filesAdded = 0;
  let filesUpdated = 0;

  try {
    const paths = await walkLibraryRoot(rootPath);

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

    const filesTotal = pathsToScan.length;

    for (const filePath of pathsToScan) {
      const outcome = await scanFile(db, libraryRootId, filePath);
      filesScanned++;
      if (outcome === "added") filesAdded++;
      if (outcome === "updated") filesUpdated++;
      onProgress?.({ jobId, libraryRootId, filesScanned, filesTotal, filesAdded, filesUpdated });
    }

    let filesMissing = 0;
    if (mode === "full") {
      const seen = new Set(paths);
      const existingPaths = db
        .prepare("SELECT file_path FROM files WHERE library_root_id = ? AND missing_since IS NULL")
        .all(libraryRootId) as { file_path: string }[];
      for (const { file_path } of existingPaths) {
        if (!seen.has(file_path)) {
          markMissing(db, file_path);
          filesMissing++;
        }
      }
    }

    // B-1: everything derived from what scan found, recomputed
    // unconditionally for every file currently in the library — not just
    // the ones this run changed. Idempotent (see seed.ts's seed_version
    // guard, deriveLocalEdges' delete-then-reinsert) on a no-op re-scan, and
    // still needed after an incremental scan: newly-added files still have
    // to get positions, entity aggregation, and similarity edges to show up
    // in the graph at all. This reads the files table as a whole rather
    // than re-checking any individual file, so it doesn't break the mode's
    // promise not to touch already-known rows.
    recompute(db);

    db.prepare(
      `UPDATE scan_jobs SET status = 'done', files_scanned = ?, files_added = ?,
         files_updated = ?, files_missing = ?, finished_at = datetime('now') WHERE id = ?`,
    ).run(filesScanned, filesAdded, filesUpdated, filesMissing, jobId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    db.prepare(
      "UPDATE scan_jobs SET status = 'error', error_message = ?, finished_at = datetime('now') WHERE id = ?",
    ).run(message, jobId);
  }
}

// Convenience for callers that want to await full completion (tests, and
// chaining "scan, then start watching" on library-root creation) rather
// than fire-and-forget an HTTP response.
export async function runFullScan(
  db: Database.Database,
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
  db: Database.Database,
  libraryRootId: number,
  rootPath: string,
  onProgress?: (progress: ScanProgress) => void,
): Promise<number> {
  const jobId = createScanJob(db, libraryRootId, "incremental");
  await executeScan(db, jobId, libraryRootId, rootPath, onProgress, "incremental");
  return jobId;
}
