import type Database from "better-sqlite3";
import { isCached, writePeaks } from "./store.js";
import { computePeaks } from "./decode.js";

export type WaveformBackfillProgress = {
  filesConsidered: number;
  peaksComputed: number;
  skipped: number;
  failures: number;
};

// A real ffmpeg decode of the whole track — 0.5-2.5s per file measured
// against the real /mnt/music library, not the cheap embedded-picture read
// cover art needed. Running that inline for every already-scanned file the
// first time this feature ships would add minutes to what's normally an
// instant no-op re-scan. scan/scanner.ts's inline ensurePeaksForFile call
// stays (a single newly-added file is a fine cost to pay inline, same as
// cover art), but backfilling an *existing* library needs the same
// separate, resumable, non-blocking tool cover/backfill.ts already
// established the shape for.
export async function backfillWaveforms(
  db: Database.Database,
  onProgress?: (progress: WaveformBackfillProgress) => void,
): Promise<WaveformBackfillProgress> {
  const files = db
    .prepare("SELECT id, file_path, file_hash FROM files WHERE missing_since IS NULL AND file_hash IS NOT NULL ORDER BY id")
    .all() as { id: number; file_path: string; file_hash: string }[];

  const progress: WaveformBackfillProgress = { filesConsidered: 0, peaksComputed: 0, skipped: 0, failures: 0 };

  for (const file of files) {
    progress.filesConsidered++;

    if (await isCached(file.file_hash)) {
      progress.skipped++;
      onProgress?.(progress);
      continue;
    }

    try {
      const peaks = await computePeaks(file.file_path);
      await writePeaks(file.file_hash, peaks);
      progress.peaksComputed++;
    } catch (err) {
      progress.failures++;
      console.warn(`waveform backfill failed for ${file.file_path}: ${err instanceof Error ? err.message : String(err)}`);
    }

    onProgress?.(progress);
  }

  return progress;
}
