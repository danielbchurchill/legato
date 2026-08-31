import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { DATA_DIR } from "../config.js";
import { FFMPEG_PATH } from "../mediaBinaries.js";

// Content-addressed by file_hash, same sharding as cover/store.ts and
// waveform/store.ts. This is what makes /files/:id/stream Range-capable:
// the old route piped a live ffmpeg process straight to the response, which
// has no fixed length and can't be seeked into, so a Range request from the
// client was silently ignored — fine for curl and desktop Chrome, but
// Safari's media engine (iOS, and some Android browsers) requires either a
// known Content-Length or real 206 support before it will start playback at
// all, not just for seeking. Transcoding once to a real file on disk first
// makes both possible, and turns every replay of a track into a cache hit
// instead of a fresh ffmpeg spawn.
const CACHE_DIR = path.join(DATA_DIR, "streams");

export function cachePath(fileHash: string): string {
  return path.join(CACHE_DIR, fileHash.slice(0, 2), `${fileHash}.flac`);
}

export async function isCached(fileHash: string): Promise<boolean> {
  try {
    await access(cachePath(fileHash));
    return true;
  } catch {
    return false;
  }
}

// Streams ffmpeg's stdout straight to the temp file rather than buffering
// the whole transcode in memory first (cover art's resize() can afford to
// buffer — a JPEG is tens of KB; a full-track FLAC transcode is tens of MB).
function transcodeToFile(sourcePath: string, targetTemp: string): Promise<void> {
  const ffmpeg = spawn(FFMPEG_PATH, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    sourcePath,
    "-map",
    "0:a:0",
    "-f",
    "flac",
    "-compression_level",
    "5",
    "pipe:1",
  ]);

  let stderr = "";
  ffmpeg.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const exited = new Promise<number | null>((resolve, reject) => {
    ffmpeg.on("error", reject);
    ffmpeg.on("close", resolve);
  });

  return pipeline(ffmpeg.stdout, createWriteStream(targetTemp)).then(async () => {
    const code = await exited;
    if (code !== 0) {
      throw new Error(`ffmpeg failed to transcode (exit ${code}): ${stderr.trim()}`);
    }
  });
}

// Idempotent, matching storeCover's contract: a file already in the cache is
// never re-transcoded. Temp-file-then-rename (same directory, so the rename
// is atomic) means a concurrent reader sees either no file (a 404, already a
// handled state upstream) or the whole thing — never a partial transcode
// served as if it were complete. Two concurrent misses for the same hash
// race to transcode independently rather than being locked against each
// other, same accepted tradeoff as storeCover's own comment on this.
export async function ensureCached(fileHash: string, sourcePath: string): Promise<string> {
  const target = cachePath(fileHash);
  if (await isCached(fileHash)) return target;

  await mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    await transcodeToFile(sourcePath, temp);
    await rename(temp, target);
  } catch (err) {
    await unlink(temp).catch(() => {});
    throw err;
  }
  return target;
}
