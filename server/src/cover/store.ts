import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../config.js";
import { FFMPEG_PATH } from "../mediaBinaries.js";
import { runMediaTask } from "../media/queue.js";

export type CoverSize = "thumb" | "full";

// Two derived sizes; the original bytes are deliberately not retained.
//
// Embedded art in the wild is routinely 3000px and several megabytes, which
// would make the cover cache larger than the entire rest of the app's data for
// a UI whose biggest cover is 255 CSS px. 512 serves that at 2x DPI with room
// to spare.
//
// 'thumb' was 128, sized against CSS pixels — 75px similarity thumbnails,
// 44px graph nodes — which is the whole reason art looked soft: a 2x display
// asks for 150 and 88 *device* pixels, and the graph's texture atlas asks for
// more still, since a node's cover keeps growing as the camera zooms in. 256
// is the smallest size that covers all three honestly, and it exactly matches
// the atlas cell Canvas.tsx forces, so a cover reaching the graph is resampled
// once (here) rather than twice. Deep zoom (past roughly a 3x camera) does
// magnify it — the alternative is 4x the atlas memory for a view nobody sits
// at, and sigma holds every visible cover in that atlas at once.
//
// If a genuine need for originals appears (exporting art, a full-screen cover
// view), that is a third size here, not a change to this policy.
const SIZES: Record<CoverSize, number> = { thumb: 256, full: 512 };

export const CACHE_DIR = path.join(DATA_DIR, "covers");

export function hashBytes(bytes: Buffer): string {
  return createHash("sha1").update(bytes).digest("hex");
}

// Sharded by hash prefix so the cache directory stays navigable — a library
// with thousands of albums otherwise puts thousands of entries in one folder,
// which some filesystems handle poorly and every file manager handles badly.
//
// The top level is the pixel bound, not the size *name*: raising 'thumb' from
// 128 to 256 under a name-keyed path would have left every already-cached
// cover serving its old 128px file forever, since isCached() tests existence
// and a cover that never changes is never re-encoded. Naming the directory
// after what is actually in it makes a ladder change self-invalidating —
// the new size is simply a cache miss — and evict.ts's sweepCoverCache()
// finds what the old ladder left behind (any numeric-named directory here
// counts, not just the two sizes above) since it walks the whole tree
// rather than trusting SIZES to enumerate what's on disk.
export function cachePath(hash: string, size: CoverSize): string {
  return path.join(CACHE_DIR, String(SIZES[size]), hash.slice(0, 2), `${hash}.jpg`);
}

export async function isCached(hash: string, size: CoverSize): Promise<boolean> {
  try {
    await access(cachePath(hash, size));
    return true;
  } catch {
    return false;
  }
}

// Resizes through ffmpeg rather than an image library.
//
// ffmpeg is already a hard dependency of this server (it backs
// GET /files/:id/stream) and M10 already has to bundle it per platform. Adding
// sharp would mean a *second* native module to package, and better-sqlite3's
// is already the known-hard part of cross-platform packaging. One less native
// dependency is worth a process spawn per cover on a path that only runs when
// a file is new or changed.
//
// force_original_aspect_ratio=decrease bounds the longest edge without
// distorting or cropping, so non-square art (singles, some vinyl scans)
// survives intact.
function resize(input: Buffer, maxEdge: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(FFMPEG_PATH, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-vf",
      `scale=${maxEdge}:${maxEdge}:force_original_aspect_ratio=decrease`,
      "-frames:v",
      "1",
      "-f",
      "mjpeg",
      "-q:v",
      "4",
      "pipe:1",
    ]);

    const chunks: Buffer[] = [];
    let stderr = "";

    ffmpeg.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    ffmpeg.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    ffmpeg.on("error", reject);
    ffmpeg.on("close", (code) => {
      if (code !== 0 || chunks.length === 0) {
        reject(new Error(`ffmpeg failed to decode cover art (exit ${code}): ${stderr.trim()}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });

    // A truncated or non-image blob makes ffmpeg exit before draining stdin,
    // which surfaces as EPIPE here rather than as the decode error above.
    // Swallow it; the close handler reports the real reason.
    ffmpeg.stdin.on("error", () => {});
    ffmpeg.stdin.end(input);
  });
}

// Writes both derived sizes for a blob and returns its hash. Idempotent: art
// already in the cache is not re-encoded, which is what makes a re-scan of an
// unchanged library cheap.
//
// Each size lands via a temp file and a rename rather than a direct write to
// its final path. Writing in place published a partially-written file at the
// name readers look for: readCover would serve a truncated JPEG (a 200 the
// browser cannot decode, which the UI can only report as missing art), and
// isCached — which tests existence, not completeness — would see that partial
// file and skip re-encoding it, so the truncation stuck until the cache was
// cleared by hand. rename within the same directory is atomic, so a concurrent
// reader sees either no file (404, already a handled state) or the whole thing.
export async function storeCover(bytes: Buffer): Promise<string> {
  const hash = hashBytes(bytes);

  for (const size of Object.keys(SIZES) as CoverSize[]) {
    if (await isCached(hash, size)) continue;
    const target = cachePath(hash, size);
    await mkdir(path.dirname(target), { recursive: true });

    // Same directory as the target: rename is only atomic within a
    // filesystem, and the uuid keeps two concurrent writers of the same hash
    // from colliding on the temp name itself.
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      // Issue #111: never playback — this runs during a scan, an
      // enrichment job, or a manual upload, so it always takes the media
      // queue's "background" lane.
      await writeFile(temp, await runMediaTask("background", () => resize(bytes, SIZES[size])));
      await rename(temp, target);
    } catch (err) {
      // Leaving a stray .tmp behind would be a leak nothing sweeps — the
      // cache has no eviction pass yet (see below).
      await unlink(temp).catch(() => {});
      throw err;
    }
  }

  return hash;
}

// Every copy of one cover already on disk, whatever size directory it landed
// in — including directories a superseded ladder wrote (`covers/full/`,
// `covers/thumb/`). Sorted largest file first, which for the same image at
// different bounds is the same order as largest *dimensions* first.
async function existingCopies(hash: string): Promise<string[]> {
  let sizeDirs: string[];
  try {
    sizeDirs = (await readdir(CACHE_DIR, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return []; // no cache directory yet
  }

  const copies: { path: string; bytes: number }[] = [];
  for (const dir of sizeDirs) {
    const candidate = path.join(CACHE_DIR, dir, hash.slice(0, 2), `${hash}.jpg`);
    try {
      copies.push({ path: candidate, bytes: (await stat(candidate)).size });
    } catch {
      // This size was never written for this hash. Normal.
    }
  }

  return copies.sort((a, b) => b.bytes - a.bytes).map((copy) => copy.path);
}

// Re-derives one missing size from the largest copy of that cover already
// cached. What makes a change to the size ladder above a plain cache miss
// rather than a migration: the original bytes are gone, but a 512px copy is a
// perfectly good source for a 256px one, so nothing has to re-read the audio
// files (the backfill this project has had to write four times already — see
// recompute.ts's B-1 note).
//
// Two things it does not try to be clever about. If the only surviving copy is
// *smaller* than the size being asked for, this upscales it — the result is no
// blurrier than what the same cache was already serving, and a rescan of the
// file writes the real thing. And when a legacy copy happens to already be at
// the requested bound (the old ladder's 512 answering a request for 512), it is
// re-encoded rather than copied, which costs one generation of JPEG loss on a
// one-time path. Detecting that would mean trusting a directory name to
// describe its contents, which is exactly the assumption the pixel-named paths
// above exist to stop making.
async function deriveSize(hash: string, size: CoverSize): Promise<Buffer | null> {
  const [largest] = await existingCopies(hash);
  if (!largest) return null;

  const target = cachePath(hash, size);
  if (path.resolve(largest) === path.resolve(target)) return null; // the miss *is* this file

  let derived: Buffer;
  try {
    const largestBytes = await readFile(largest);
    // Same "background" lane as storeCover above — this fires from
    // readCover() serving a size that hasn't been derived yet, never from
    // a playback path.
    derived = await runMediaTask("background", () => resize(largestBytes, SIZES[size]));
  } catch {
    return null;
  }

  await mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, derived);
    await rename(temp, target);
  } catch {
    await unlink(temp).catch(() => {});
    // Failing to *cache* the derived bytes doesn't make them any less
    // correct — serve them and let the next request try the write again.
  }
  return derived;
}

// Replacing or deleting a manual override leaves its blob on disk with no
// cover_art row pointing at it, and a superseded size ladder leaves its
// whole directory behind (still useful, as deriveSize's source, until it
// is). Harmless per-orphan (a few tens of KB) but unbounded over time —
// evict.ts's sweepCoverCache() is the manual sweep for it (`npm run
// sweep:caches`), using this table's cover_art_hash index to find live
// hashes cheaply. Not run automatically; a human runs it.
export async function readCover(hash: string, size: CoverSize): Promise<Buffer | null> {
  try {
    return await readFile(cachePath(hash, size));
  } catch {
    // Not cached at this size. Either art stored under an older ladder, or a
    // blob someone cleared by hand — both recoverable from another size.
    return await deriveSize(hash, size);
  }
}
