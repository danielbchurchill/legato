import { openDb } from "../db.js";
import { backfillCovers } from "./backfill.js";

// One-off entry point: `npm --prefix server run backfill:covers`.
//
// Safe to re-run — albums that already have art are skipped without opening a
// file, so a second run over a finished library is close to free.
const db = openDb();

let lastLine = 0;
const progress = await backfillCovers(db, (p) => {
  // Report every 25 files rather than every file; a large library otherwise
  // spends more time writing to the terminal than reading tags.
  if (p.filesConsidered - lastLine < 25) return;
  lastLine = p.filesConsidered;
  process.stdout.write(
    `\r${p.filesConsidered} files · ${p.coversAdded} covers · ${p.albumsSkipped} already had art`,
  );
});

process.stdout.write("\r\x1b[K");
console.log(
  `done: ${progress.filesConsidered} files considered, ${progress.coversAdded} covers added, ` +
    `${progress.albumsSkipped} skipped, ${progress.failures} failed`,
);

db.close();
