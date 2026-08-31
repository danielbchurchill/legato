import type Database from "better-sqlite3";
import path from "node:path";
import { sweepCache, type SweepReport } from "../maintenance/evict.js";
import { CACHE_DIR } from "./store.js";

// Every hash any node still points at — across every source (embedded,
// folder, caa, manual) and however many nodes share one image. Anything
// cached on disk outside this set, in any size directory, is a leak per
// store.ts's own "Known gap" note above readCover(): a replaced or deleted
// manual override, or a whole directory a superseded size ladder left
// behind. cover_art_hash exists precisely so this query is cheap.
function liveCoverHashes(db: Database.Database): Set<string> {
  const rows = db.prepare("SELECT DISTINCT hash FROM cover_art").all() as { hash: string }[];
  return new Set(rows.map((row) => row.hash));
}

// Extension-gated rather than hash-shape-validated: cachePath() only ever
// writes `<hash>.jpg`, and a write-in-progress temp file is named
// `<hash>.jpg.<uuid>.tmp` — extname() on that is `.tmp`, not `.jpg`, so a
// mid-write file is silently skipped rather than raced or reported as an
// orphan. Runs the same regardless of which size directory the file is
// under, which is what makes a stale rung of the size ladder (see store.ts)
// sweep away the same as an ordinary orphan.
function parseHash(filePath: string): string | null {
  if (path.extname(filePath) !== ".jpg") return null;
  return path.basename(filePath, ".jpg");
}

export async function sweepCoverCache(
  db: Database.Database,
  { dryRun = true, cacheDir = CACHE_DIR }: { dryRun?: boolean; cacheDir?: string } = {},
): Promise<SweepReport> {
  return sweepCache(cacheDir, liveCoverHashes(db), parseHash, dryRun);
}
