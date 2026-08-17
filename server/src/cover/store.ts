import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../config.js";

export type CoverSize = "thumb" | "full";

// Two derived sizes; the original bytes are deliberately not retained.
//
// Embedded art in the wild is routinely 3000px and several megabytes, which
// would make the cover cache larger than the entire rest of the app's data for
// a UI whose biggest cover is 255 CSS px. 512 serves that at 2x DPI with room
// to spare; 128 serves the 75px similarity thumbnails and the 44px graph nodes.
//
// If a genuine need for originals appears (exporting art, a full-screen cover
// view), that is a third size here, not a change to this policy.
const SIZES: Record<CoverSize, number> = { thumb: 128, full: 512 };

const CACHE_DIR = path.join(DATA_DIR, "covers");

export function hashBytes(bytes: Buffer): string {
  return createHash("sha1").update(bytes).digest("hex");
}

// Sharded by hash prefix so the cache directory stays navigable — a library
// with thousands of albums otherwise puts thousands of entries in one folder,
// which some filesystems handle poorly and every file manager handles badly.
export function cachePath(hash: string, size: CoverSize): string {
  return path.join(CACHE_DIR, size, hash.slice(0, 2), `${hash}.jpg`);
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
    const ffmpeg = spawn("ffmpeg", [
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
      await writeFile(temp, await resize(bytes, SIZES[size]));
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

// Known gap: nothing evicts the cache. Replacing or deleting a manual override
// leaves its blob on disk with no cover_art row pointing at it. Harmless (a few
// tens of KB per orphan) and bounded by how often art is overridden by hand,
// but it is a real leak. The cover_art_hash index exists so a sweep can find
// live hashes cheaply; write that alongside the Cover Art Archive fetcher,
// which will be the first thing to churn cached art in volume.
export async function readCover(hash: string, size: CoverSize): Promise<Buffer | null> {
  try {
    return await readFile(cachePath(hash, size));
  } catch {
    return null;
  }
}
