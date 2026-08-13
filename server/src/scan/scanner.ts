import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3";
import { recomputeAllSeeds } from "../layout/seed.js";
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

  const [tags, fileHash] = await Promise.all([parseTags(filePath), hashFilePrefix(filePath)]);
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
           file_mtime, file_size, file_hash, tags_raw
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
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

export type ScanProgress = {
  jobId: number;
  filesScanned: number;
  filesAdded: number;
  filesUpdated: number;
};

// Split in two so an HTTP caller can get a job id back immediately instead
// of blocking the request for however long the whole walk takes:
// createScanJob() is a single fast synchronous insert, executeScan() is the
// long-running part a route handler fires-and-forgets while the client
// polls GET /api/v1/scan-jobs/:id for status.
export function createScanJob(db: Database.Database, libraryRootId: number): number {
  const job = db
    .prepare("INSERT INTO scan_jobs (library_root_id, status) VALUES (?, 'running') RETURNING id")
    .get(libraryRootId) as { id: number };
  return job.id;
}

export async function executeScan(
  db: Database.Database,
  jobId: number,
  libraryRootId: number,
  rootPath: string,
  onProgress?: (progress: ScanProgress) => void,
): Promise<void> {
  let filesScanned = 0;
  let filesAdded = 0;
  let filesUpdated = 0;

  try {
    const paths = await walkLibraryRoot(rootPath);
    const seen = new Set(paths);

    for (const filePath of paths) {
      const outcome = await scanFile(db, libraryRootId, filePath);
      filesScanned++;
      if (outcome === "added") filesAdded++;
      if (outcome === "updated") filesUpdated++;
      onProgress?.({ jobId, filesScanned, filesAdded, filesUpdated });
    }

    const existingPaths = db
      .prepare("SELECT file_path FROM files WHERE library_root_id = ? AND missing_since IS NULL")
      .all(libraryRootId) as { file_path: string }[];
    let filesMissing = 0;
    for (const { file_path } of existingPaths) {
      if (!seen.has(file_path)) {
        markMissing(db, file_path);
        filesMissing++;
      }
    }

    // Recomputed once per scan (not per-file) — it's a global pass over
    // every recording node's current released_in edge, cheap at this scale
    // and idempotent (see seed.ts's seed_version guard) on a no-op re-scan.
    recomputeAllSeeds(db);

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
  const jobId = createScanJob(db, libraryRootId);
  await executeScan(db, jobId, libraryRootId, rootPath, onProgress);
  return jobId;
}
