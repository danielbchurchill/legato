import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { access, mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { DATA_DIR } from "../config.js";
import { FFMPEG_PATH } from "../mediaBinaries.js";
import { runMediaTask } from "../media/queue.js";
import { VARIANTS, type TranscodedQuality } from "./quality.js";

// Content-addressed by file_hash, same sharding as cover/store.ts and
// waveform/store.ts, with one directory per quality rung on top
// (streams/<quality>/<hash prefix>/<hash>.<ext>) — #120's cache key is the
// pair, and keeping the rung as a directory rather than a filename suffix
// means the sweep can tell every variant of a hash apart from the layout
// alone. A finished file on disk is what makes /files/:id/stream
// Range-capable: Safari's media engine (iOS, and some Android browsers)
// wants a known Content-Length or real 206 support before it will seek, and
// every replay of a track becomes a cache hit instead of a fresh ffmpeg
// spawn.
export const CACHE_DIR = path.join(DATA_DIR, "streams");

export function cachePath(fileHash: string, quality: TranscodedQuality, cacheDir = CACHE_DIR): string {
  return path.join(cacheDir, quality, fileHash.slice(0, 2), `${fileHash}.${VARIANTS[quality].extension}`);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

// One encode in progress. Readers follow `tempPath` as it grows, reading
// only up to `flushedBytes` — bytes the write stream has confirmed landed
// on disk, not merely bytes ffmpeg has produced — so a reader never reads
// past what the file actually holds and mistakes that for the end.
export class TranscodeJob {
  readonly tempPath: string;
  readonly targetPath: string;
  flushedBytes = 0;
  state: "running" | "done" | "failed" = "running";
  error: Error | null = null;
  // Settles on the first flushed byte, or on failure before any. The route
  // waits on this before sending headers, so a file ffmpeg can't open still
  // gets a real 502 instead of a 200 that dies empty.
  readonly started: Promise<void>;
  readonly finished: Promise<void>;
  private wakeReaders: (() => void)[] = [];
  private resolveStarted!: () => void;
  private rejectStarted!: (err: Error) => void;

  constructor(tempPath: string, targetPath: string, run: (job: TranscodeJob) => Promise<void>) {
    this.tempPath = tempPath;
    this.targetPath = targetPath;
    this.started = new Promise((resolve, reject) => {
      this.resolveStarted = resolve;
      this.rejectStarted = reject;
    });
    // A route that already sent headers only ever learns of a failure by
    // reading, so an unobserved rejection here isn't an unhandled one.
    this.started.catch(() => {});
    this.finished = run(this).then(
      () => {
        this.state = "done";
        this.resolveStarted();
        this.notify();
      },
      (err: Error) => {
        this.state = "failed";
        this.error = err;
        this.rejectStarted(err);
        this.notify();
        throw err;
      },
    );
    this.finished.catch(() => {});
  }

  flushed(bytes: number): void {
    this.flushedBytes += bytes;
    if (this.flushedBytes > 0) this.resolveStarted();
    this.notify();
  }

  // Resolves on the next flush or state change.
  changed(): Promise<void> {
    return new Promise((resolve) => this.wakeReaders.push(resolve));
  }

  private notify(): void {
    const waiting = this.wakeReaders;
    this.wakeReaders = [];
    for (const wake of waiting) wake();
  }
}

// Reads a job's output from the first byte while it's still being written,
// then to the end once it finishes. The handle is opened once, up front,
// so the encode's closing rename (temp -> target) doesn't pull the file out
// from under a reader mid-way: POSIX keeps an open file readable across a
// rename, and libuv opens with FILE_SHARE_DELETE on Windows for the same
// guarantee. A job that finished before this reader got to it is read from
// its target path instead.
export async function* readGrowing(job: TranscodeJob, chunkSize = 64 * 1024): AsyncGenerator<Buffer> {
  // The temp file only exists once the job holds a media-queue slot and
  // ffmpeg has written something; before that there's nothing to open.
  await job.started;
  let handle: FileHandle;
  try {
    handle = await open(job.tempPath, "r");
  } catch (err) {
    if (job.state !== "done") throw err;
    handle = await open(job.targetPath, "r");
  }

  try {
    let offset = 0;
    for (;;) {
      if (offset < job.flushedBytes) {
        const length = Math.min(chunkSize, job.flushedBytes - offset);
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        offset += bytesRead;
        yield buffer.subarray(0, bytesRead);
        continue;
      }
      if (job.state === "done") return;
      if (job.state === "failed") throw job.error;
      await job.changed();
    }
  } finally {
    await handle.close();
  }
}

// Its stdout goes before the signal. ffmpeg traps SIGTERM to write out
// what it has, and if its stdout is paused for backpressure
// (transcodeToFile), that write blocks on the full pipe for ever: the
// process never exits, and never gives its media-queue slot back. With
// the pipe's read end gone, the write fails and it exits at once.
export function stopFfmpeg(ffmpeg: ChildProcessByStdio<null, Readable, Readable>): void {
  ffmpeg.stdout.destroy();
  ffmpeg.kill();
}

// Writes ffmpeg's stdout to the temp file chunk by chunk, telling the job
// about each chunk only once its write has completed. Backpressure is
// manual (pause stdout until the file drains) because pipeline() has no
// per-chunk completion hook to hang the flush count on.
function transcodeToFile(sourcePath: string, quality: TranscodedQuality, job: TranscodeJob): Promise<void> {
  const ffmpeg = spawn(FFMPEG_PATH, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    sourcePath,
    "-map",
    "0:a:0",
    "-vn",
    ...VARIANTS[quality].encoderArgs,
    "pipe:1",
  ]);

  let stderr = "";
  ffmpeg.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  return new Promise<void>((resolve, reject) => {
    const out: WriteStream = createWriteStream(job.tempPath);
    let failed = false;
    const fail = (err: Error) => {
      if (failed) return;
      failed = true;
      stopFfmpeg(ffmpeg);
      out.destroy();
      reject(err);
    };

    out.on("error", fail);
    ffmpeg.on("error", fail);
    ffmpeg.stdout.on("data", (chunk: Buffer) => {
      const accepted = out.write(chunk, (err) => {
        if (!err) job.flushed(chunk.length);
      });
      if (!accepted) {
        ffmpeg.stdout.pause();
        out.once("drain", () => ffmpeg.stdout.resume());
      }
    });
    ffmpeg.on("close", (code) => {
      if (failed) return;
      if (code !== 0) {
        fail(new Error(`ffmpeg failed to transcode to ${quality} (exit ${code}): ${stderr.trim()}`));
        return;
      }
      // end()'s callback runs after every queued write's own callback, so
      // flushedBytes is the whole file by the time this resolves.
      out.end(() => resolve());
    });
  });
}

// One job per (hash, quality) at a time. Two listeners starting the same
// track at the same rung share one ffmpeg process and both follow its
// output, rather than racing two encodes of identical bytes.
const inFlight = new Map<string, TranscodeJob>();

export type CachedVariant = { kind: "complete"; path: string } | { kind: "growing"; job: TranscodeJob };

// Idempotent: a finished variant is never re-encoded. The temp file is
// renamed into place only once ffmpeg exits cleanly (same directory, so the
// rename is atomic), which keeps the "a file at cachePath is whole"
// guarantee every cache hit and the sweep depend on; a reader that wants
// bytes sooner follows the job instead.
//
// Issue #111: every encode through here is real playback, so it takes the
// media queue's "playback" lane, ahead of whatever background
// fingerprinting/cover/waveform work a scan already has queued.
export async function ensureVariant(
  fileHash: string,
  sourcePath: string,
  quality: TranscodedQuality,
  cacheDir = CACHE_DIR,
): Promise<CachedVariant> {
  const target = cachePath(fileHash, quality, cacheDir);
  const key = `${quality}:${fileHash}`;

  const running = inFlight.get(key);
  if (running) return { kind: "growing", job: running };
  if (await exists(target)) return { kind: "complete", path: target };
  // The await above yields, so a second request for the same key may have
  // started the job in the meantime.
  const raced = inFlight.get(key);
  if (raced) return { kind: "growing", job: raced };

  const temp = `${target}.${randomUUID()}.tmp`;
  const job = new TranscodeJob(temp, target, async (self) => {
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await runMediaTask("playback", () => transcodeToFile(sourcePath, quality, self));
      await rename(temp, target);
    } catch (err) {
      await unlink(temp).catch(() => {});
      throw err;
    } finally {
      inFlight.delete(key);
    }
  });
  inFlight.set(key, job);
  return { kind: "growing", job };
}
