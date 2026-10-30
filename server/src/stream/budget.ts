import { readdir, stat, unlink, utimes } from "node:fs/promises";
import path from "node:path";
import { STREAM_CACHE_BUDGET } from "../config.js";
import { VARIANTS, type TranscodedQuality } from "./quality.js";

// #423: every rung a client asks for is cached (stream/cache.ts), and the
// orphan sweep only removes what no file has any more, so without a budget a
// browser away from home, or a phone on the standard rung, adds every track
// it plays. The Raspberry Pi this runs on keeps the cache on an SD card. So
// the whole cache, every rung together, has one budget (config.ts,
// LEGATO_STREAM_CACHE_MB), and once it's over, the files served longest ago
// go first, whichever rung they're in. Each is one ffmpeg run to make
// again; a remux (original-fmp4, #408) is a quick stream copy. `original` is
// the source file itself and never cached.

// Served this recently, a file is probably in the queue being played, and
// the player comes back for its later fragments with Range requests.
export const RECENTLY_SERVED_MS = 10 * 60_000;

// Serving a cached file sets its mtime to now, which is what the budget
// reads as "last served". Only once a minute: the player asks for a track a
// fragment at a time, and an SD card needn't take a metadata write for each.
const TOUCH_AFTER_MS = 60_000;

/** Marks a cached file as just served. Never throws: a file the budget
 * removed a moment ago is simply made again next time. */
export async function noteServed(filePath: string, now = Date.now()): Promise<void> {
  try {
    const { mtimeMs } = await stat(filePath);
    if (now - mtimeMs < TOUCH_AFTER_MS) return;
    const at = new Date(now);
    await utimes(filePath, at, at);
  } catch {
    // Gone already.
  }
}

type Entry = { path: string; bytes: number; servedAt: number; finished: boolean };

// Every file in a rung's directory (<quality>/<prefix>/<file>). Anything
// else under the cache root, such as the pre-#120 layout or a directory no
// rung has, is neither counted nor removed: the orphan sweep judges those
// (stream/evict.ts).
async function entries(cacheDir: string): Promise<Entry[]> {
  const found: Entry[] = [];
  for (const quality of Object.keys(VARIANTS) as TranscodedQuality[]) {
    const dir = path.join(cacheDir, quality);
    const extension = `.${VARIANTS[quality].extension}`;
    let shards;
    try {
      shards = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const shard of shards) {
      if (!shard.isDirectory()) continue;
      const shardDir = path.join(dir, shard.name);
      for (const name of await readdir(shardDir).catch(() => [])) {
        const filePath = path.join(shardDir, name);
        try {
          const info = await stat(filePath);
          if (!info.isFile()) continue;
          // A `<hash>.m4a.<uuid>.tmp` is an encode still being written. Its
          // bytes are on the disk, but it's never this trim's to remove.
          found.push({
            path: filePath,
            bytes: info.size,
            servedAt: info.mtimeMs,
            finished: path.extname(name) === extension,
          });
        } catch {
          // Renamed or removed while listing.
        }
      }
    }
  }
  return found;
}

export type TrimResult = { removed: string[]; removedBytes: number; totalBytes: number };

/** Removes the cached files served longest ago, across every rung, until
 * the cache is within `maxBytes`. Anything still being written, or served
 * within `recentMs`, stays, even if that leaves the cache over budget for a
 * while. `totalBytes` is what the cache holds afterwards. */
export async function trimStreamCache({
  cacheDir,
  maxBytes = STREAM_CACHE_BUDGET.bytes,
  recentMs = RECENTLY_SERVED_MS,
  now = Date.now(),
}: {
  cacheDir: string;
  maxBytes?: number;
  recentMs?: number;
  now?: number;
}): Promise<TrimResult> {
  const all = await entries(cacheDir);
  let total = all.reduce((sum, entry) => sum + entry.bytes, 0);
  const removed: string[] = [];
  let removedBytes = 0;
  const oldestFirst = all.filter((entry) => entry.finished).sort((a, b) => a.servedAt - b.servedAt);
  for (const entry of oldestFirst) {
    if (total <= maxBytes || now - entry.servedAt < recentMs) break;
    try {
      // Listing a big cache takes a while, and a request may have served
      // this file since.
      if (now - (await stat(entry.path)).mtimeMs < recentMs) continue;
      await unlink(entry.path);
      removed.push(entry.path);
      removedBytes += entry.bytes;
    } catch (err) {
      // Removed by someone else meanwhile, so its bytes are gone either
      // way. Anything else, such as a permission error, leaves it there.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") continue;
    }
    total -= entry.bytes;
  }
  return { removed, removedBytes, totalBytes: total };
}

// One trim at a time: two transcodes finishing together would otherwise
// both list the cache and count the same files twice.
let trimming: Promise<unknown> = Promise.resolve();

/** Runs trimStreamCache after any trim already under way. */
export function scheduleTrim(cacheDir: string, maxBytes = STREAM_CACHE_BUDGET.bytes): Promise<TrimResult> {
  const run = trimming.then(() => trimStreamCache({ cacheDir, maxBytes }));
  trimming = run.catch(() => undefined);
  return run;
}
