import { openDb } from "../db.js";
import { backfillTagColumns } from "./backfill-tags.js";

// One-off entry point: `npm --prefix server run backfill:tags`.
//
// Safe to re-run — files that already have a value in these columns are
// skipped without re-parsing, so a second run over a finished library is
// close to free.
const db = openDb();

let lastLine = 0;
const progress = await backfillTagColumns(db, (p) => {
  if (p.filesConsidered - lastLine < 25) return;
  lastLine = p.filesConsidered;
  process.stdout.write(`\r${p.filesConsidered} files · ${p.filesUpdated} updated`);
});

process.stdout.write("\r\x1b[K");
console.log(`done: ${progress.filesConsidered} files considered, ${progress.filesUpdated} updated, ${progress.failures} failed`);

db.close();
