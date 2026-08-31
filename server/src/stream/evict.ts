import type Database from "better-sqlite3";
import path from "node:path";
import { sweepCache, type SweepReport } from "../maintenance/evict.js";
import { CACHE_DIR } from "./cache.js";

// Every file_hash any scanned file currently has. A transcode cached under a
// hash no row references any more — the source file was removed, replaced,
// or re-hashed on a re-scan — is an orphan; ensureCached() never revisits an
// old hash to clean it up, same open-ended leak as the cover cache's.
function liveStreamHashes(db: Database.Database): Set<string> {
  const rows = db
    .prepare("SELECT DISTINCT file_hash FROM files WHERE file_hash IS NOT NULL")
    .all() as { file_hash: string }[];
  return new Set(rows.map((row) => row.file_hash));
}

// Same reasoning as cover/evict.ts's parseHash: extension-gated so a
// `<hash>.flac.<uuid>.tmp` left by an interrupted transcode reads as
// `.tmp`, not `.flac`, and is left alone rather than raced or flagged.
function parseHash(filePath: string): string | null {
  if (path.extname(filePath) !== ".flac") return null;
  return path.basename(filePath, ".flac");
}

export async function sweepStreamCache(
  db: Database.Database,
  { dryRun = true, cacheDir = CACHE_DIR }: { dryRun?: boolean; cacheDir?: string } = {},
): Promise<SweepReport> {
  return sweepCache(cacheDir, liveStreamHashes(db), parseHash, dryRun);
}
