import { sweepCoverCache } from "../cover/evict.js";
import { openDb } from "../db.js";
import { sweepStreamCache } from "../stream/evict.js";
import type { SweepReport } from "./evict.js";

// One-off entry point: `npm --prefix server run sweep:caches` (report only)
// or `npm --prefix server run sweep:caches -- --apply` (actually delete).
//
// Dry run by default, matching this project's stated caution around
// destructive operations elsewhere (tagwrite's mandatory diff before any
// write): report what would be removed, delete only when explicitly told
// to. Not wired to run automatically anywhere — a human runs this.
const apply = process.argv.includes("--apply");

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function report(label: string, sweep: SweepReport): void {
  console.log(
    `\n${label}: ${sweep.liveHashCount} live hash(es), ${sweep.orphans.length} orphan file(s), ` +
      `${formatBytes(sweep.orphanBytes)}`,
  );
  for (const orphan of sweep.orphans) {
    console.log(`  ${apply ? "deleted" : "orphan"}  ${orphan.path}  (${formatBytes(orphan.bytes)})`);
  }
}

const db = openDb();

report("covers", await sweepCoverCache(db, { dryRun: !apply }));
report("streams", await sweepStreamCache(db, { dryRun: !apply }));

console.log(
  apply
    ? "\napplied: the orphans listed above were deleted."
    : "\ndry run: nothing deleted. Re-run with --apply to delete the orphans listed above.",
);

db.close();
