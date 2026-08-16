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
// B-4: a real ffmpeg decode failure (Leopard-Skin Pill-Box Hat.flac, noted
// in session 6) only ever reached a console.warn — a file that scans fine
// and will not play was invisible to the one screen built to surface
// exactly that. Persisted through field_provenance the same way
// worker.ts's recordProvenance already tracks per-node state: a failure
// writes the error as `value`, a later success writes NULL, and
// hygiene.ts's worklist query (MAX(id) per node) reads whichever happened
// most recently — self-clearing if Daniel re-encodes the file and backfill
// runs again, with no separate "is this still broken" check needed.
function recordDecodeOutcome(db: Database.Database, recordingNodeId: number, error: string | null): void {
  db.prepare(
    "INSERT INTO field_provenance (node_id, field, value, source, note) VALUES (?, 'decode_error', ?, 'local', ?)",
  ).run(recordingNodeId, error, error);
}

export async function backfillWaveforms(
  db: Database.Database,
  onProgress?: (progress: WaveformBackfillProgress) => void,
): Promise<WaveformBackfillProgress> {
  const files = db
    .prepare(
      "SELECT id, file_path, file_hash, recording_node_id FROM files WHERE missing_since IS NULL AND file_hash IS NOT NULL ORDER BY id",
    )
    .all() as { id: number; file_path: string; file_hash: string; recording_node_id: number }[];

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
      recordDecodeOutcome(db, file.recording_node_id, null);
      progress.peaksComputed++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      recordDecodeOutcome(db, file.recording_node_id, message);
      progress.failures++;
      console.warn(`waveform backfill failed for ${file.file_path}: ${message}`);
    }

    onProgress?.(progress);
  }

  return progress;
}
