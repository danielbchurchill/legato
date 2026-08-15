import { openDb } from "../db.js";
import { backfillWaveforms } from "./backfill.js";

// One-off entry point: `npm --prefix server run backfill:waveforms`.
//
// Safe to re-run — files already cached (by hash) are skipped without a
// decode, so a second run over a finished library is close to free.
const db = openDb();

let lastLine = 0;
const progress = await backfillWaveforms(db, (p) => {
  // Report every 10 files rather than every file — a decode-per-file pass
  // is slow enough that terminal output isn't the bottleneck, but still no
  // reason to spam a line per track.
  if (p.filesConsidered - lastLine < 10) return;
  lastLine = p.filesConsidered;
  process.stdout.write(`\r${p.filesConsidered} files · ${p.peaksComputed} computed · ${p.skipped} already cached`);
});

process.stdout.write("\r\x1b[K");
console.log(
  `done: ${progress.filesConsidered} files considered, ${progress.peaksComputed} computed, ` +
    `${progress.skipped} already cached, ${progress.failures} failed`,
);

db.close();
