import type { Database } from "../sqlite.js";
import path from "node:path";
import { sweepCache, type SweepReport } from "../maintenance/evict.js";
import { CACHE_DIR } from "./cache.js";
import { isTranscodedQuality, VARIANTS } from "./quality.js";

// Every file_hash any scanned file currently has. A transcode cached under a
// hash no row references any more — the source file was removed, replaced,
// or re-hashed on a re-scan — is an orphan; ensureVariant() never revisits
// an old hash to clean it up, same open-ended leak as the cover cache's.
function liveStreamHashes(db: Database): Set<string> {
  const rows = db
    .prepare("SELECT DISTINCT file_hash FROM files WHERE file_hash IS NOT NULL")
    .all() as { file_hash: string }[];
  return new Set(rows.map((row) => row.file_hash));
}

// Can never equal a real file_hash (those are hex), so returning it marks a
// file an orphan whatever the live set holds.
const NEVER_LIVE = "\0superseded";

// Reads a cache file's hash back out of its path relative to the cache
// root, across every quality rung (stream/cache.ts's cachePath:
// <quality>/<prefix>/<hash>.<ext>). Extension-gated per rung, same reasoning
// as cover/evict.ts's parseHash: a `<hash>.opus.<uuid>.tmp` an interrupted
// encode left reads as `.tmp` and is left alone rather than raced.
//
// The one shape that is deliberately always an orphan is the pre-#120
// layout, <prefix>/<hash>.flac straight under the root: those were FLAC
// re-encodes for what is now `original`, which streams from the source file
// and is never cached, so nothing will ever read them again. Anything else
// (an unknown rung directory, a stray file at the root) is not this cache's
// to judge and is left in place.
export function streamCacheHash(cacheDir: string, filePath: string): string | null {
  const relative = path.relative(cacheDir, filePath);
  // walkFiles never leaves the root, but this is the line that decides
  // what gets unlinked, so it refuses on its own anything outside it.
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  const segments = relative.split(path.sep);

  if (segments.length === 2 && path.extname(filePath) === ".flac") return NEVER_LIVE;
  if (segments.length !== 3) return null;

  const [quality] = segments;
  if (!isTranscodedQuality(quality)) return null;
  const extension = `.${VARIANTS[quality].extension}`;
  if (path.extname(filePath) !== extension) return null;
  return path.basename(filePath, extension);
}

export async function sweepStreamCache(
  db: Database,
  { dryRun = true, cacheDir = CACHE_DIR }: { dryRun?: boolean; cacheDir?: string } = {},
): Promise<SweepReport> {
  return sweepCache(cacheDir, liveStreamHashes(db), (filePath) => streamCacheHash(cacheDir, filePath), dryRun);
}
