import { readdir, stat, unlink, utimes } from "node:fs/promises";
import path from "node:path";
import { VARIANTS } from "./quality.js";

// #408: original-fmp4 is about the size of its source, a 16-bit FLAC's
// 30 MB or a 96 kHz one's 100 MB, where an AAC rung is a quarter of that.
// The stream cache has no size limit (the sweep only removes orphans), and a
// Raspberry Pi keeps it on an SD card that a phone playing through the
// library at home would fill. So this rung alone has a cap, and gives up
// what was served longest ago once a new remux takes it over. A remux is a
// stream copy, quick to make again. A budget for every rung is a follow-up.
export const ORIGINAL_FMP4_CACHE_BYTES = 2 * 1024 ** 3;

// Served this recently, a remux is probably in the queue being played, and
// the player comes back for its later fragments with Range requests.
export const RECENTLY_SERVED_MS = 10 * 60_000;

// Serving a remux sets its mtime to now, which is what the budget reads as
// "last served". Only once a minute: the player asks for a track a fragment
// at a time, and an SD card needn't take a metadata write for each.
const TOUCH_AFTER_MS = 60_000;

const EXTENSION = `.${VARIANTS["original-fmp4"].extension}`;

/** Marks a cached remux as just served. Never throws: a file the budget
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

async function entries(dir: string): Promise<Entry[]> {
  let shards;
  try {
    shards = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: Entry[] = [];
  for (const shard of shards) {
    if (!shard.isDirectory()) continue;
    const shardDir = path.join(dir, shard.name);
    for (const name of await readdir(shardDir).catch(() => [])) {
      const filePath = path.join(shardDir, name);
      try {
        const info = await stat(filePath);
        if (!info.isFile()) continue;
        // A `<hash>.m4a.<uuid>.tmp` is an encode still being written. Its
        // bytes are on the disk, but it's never this sweep's to remove.
        found.push({
          path: filePath,
          bytes: info.size,
          servedAt: info.mtimeMs,
          finished: path.extname(name) === EXTENSION,
        });
      } catch {
        // Renamed or removed while listing.
      }
    }
  }
  return found;
}

/** Removes the remuxes served longest ago until the rung's directory is
 * within `maxBytes`. Anything still being written, or served within
 * `recentMs`, stays, even if that leaves the directory over the cap for a
 * while. Returns the paths removed. */
export async function trimOriginalFmp4({
  cacheDir,
  maxBytes = ORIGINAL_FMP4_CACHE_BYTES,
  recentMs = RECENTLY_SERVED_MS,
  now = Date.now(),
}: {
  cacheDir: string;
  maxBytes?: number;
  recentMs?: number;
  now?: number;
}): Promise<string[]> {
  const all = await entries(path.join(cacheDir, "original-fmp4"));
  let total = all.reduce((sum, entry) => sum + entry.bytes, 0);
  const removed: string[] = [];
  const oldestFirst = all.filter((entry) => entry.finished).sort((a, b) => a.servedAt - b.servedAt);
  for (const entry of oldestFirst) {
    if (total <= maxBytes || now - entry.servedAt < recentMs) break;
    try {
      await unlink(entry.path);
      removed.push(entry.path);
    } catch {
      // Removed by someone else meanwhile; its bytes are gone either way.
    }
    total -= entry.bytes;
  }
  return removed;
}

// One trim at a time: two remuxes finishing together would otherwise both
// list the directory and count the same files twice.
let trimming: Promise<unknown> = Promise.resolve();

/** Runs trimOriginalFmp4 after any trim already under way. */
export function scheduleTrim(cacheDir: string): Promise<string[]> {
  const run = trimming.then(() => trimOriginalFmp4({ cacheDir }));
  trimming = run.catch(() => undefined);
  return run;
}
