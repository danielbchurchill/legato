import type Database from "better-sqlite3";
import { computePeaks } from "./decode.js";
import { isCached, readPeaks, writePeaks } from "./store.js";

// Cached by file_hash, not file id — two files sharing a hash (an exact
// duplicate, or the same track copied under a different library root)
// share one computed envelope, the same reasoning cover/store.ts's cache
// already uses for cover art.
export async function getOrComputePeaks(db: Database.Database, fileId: number): Promise<number[] | null> {
  const file = db.prepare("SELECT file_path, file_hash FROM files WHERE id = ?").get(fileId) as
    | { file_path: string; file_hash: string | null }
    | undefined;
  if (!file || !file.file_hash) return null;

  const cached = await readPeaks(file.file_hash);
  if (cached) return cached;

  const peaks = await computePeaks(file.file_path);
  await writePeaks(file.file_hash, peaks);
  return peaks;
}

// Called from scan/scanner.ts, same inline/non-fatal shape as
// cover/extract.ts's attachCoverForFile — computes and caches peaks for a
// freshly-scanned file without making the scan wait on anything already
// cached (isCached is a cheap stat, computePeaks is a real ffmpeg decode).
export async function ensurePeaksForFile(db: Database.Database, fileId: number): Promise<void> {
  const file = db.prepare("SELECT file_path, file_hash FROM files WHERE id = ?").get(fileId) as
    | { file_path: string; file_hash: string | null }
    | undefined;
  if (!file || !file.file_hash) return;
  if (await isCached(file.file_hash)) return;

  const peaks = await computePeaks(file.file_path);
  await writePeaks(file.file_hash, peaks);
}
