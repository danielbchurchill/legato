import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { appendFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cachePath, ensureVariant, readGrowing, stopFfmpeg, TranscodeJob } from "./cache.js";

const HASH = "0123456789abcdef0123456789abcdef01234567";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "legato-stream-cache-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function collect(stream: AsyncIterable<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// A real FLAC source, same as tagwrite's fixtures: the encode paths under
// test are ffmpeg's, so a hand-built header would prove nothing.
function sineFlac(seconds: number): string {
  const source = path.join(dir, "source.flac");
  execFileSync("ffmpeg", ["-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`, source], {
    stdio: "ignore",
  });
  return source;
}

describe("cachePath", () => {
  it("nests each quality under its own directory, then shards by hash prefix", () => {
    expect(cachePath(HASH, "opus160", dir)).toBe(path.join(dir, "opus160", "01", `${HASH}.opus`));
    expect(cachePath(HASH, "aac256", dir)).toBe(path.join(dir, "aac256", "01", `${HASH}.m4a`));
  });

  it("keeps two qualities of one hash apart", () => {
    expect(cachePath(HASH, "opus96", dir)).not.toBe(cachePath(HASH, "opus256", dir));
  });
});

describe("readGrowing", () => {
  it("yields bytes as they're flushed, before the job has finished", async () => {
    const temp = path.join(dir, "growing.tmp");
    const target = path.join(dir, "growing.done");
    let finishWriting!: () => void;
    const job = new TranscodeJob(temp, target, async (self) => {
      await writeFile(temp, "first ");
      self.flushed(6);
      await new Promise<void>((resolve) => (finishWriting = resolve));
      await appendFile(temp, "second");
      self.flushed(6);
    });

    await job.started;
    const reader = readGrowing(job);
    const first = await reader.next();
    expect(first.value?.toString()).toBe("first ");
    expect(job.state).toBe("running");

    finishWriting();
    const rest = await collect({ [Symbol.asyncIterator]: () => reader });
    expect(rest.toString()).toBe("second");
  });

  it("errors the reader when the job fails part-way through", async () => {
    const temp = path.join(dir, "failing.tmp");
    let fail!: () => void;
    const job = new TranscodeJob(temp, path.join(dir, "never"), async (self) => {
      await writeFile(temp, "partial");
      self.flushed(7);
      await new Promise<void>((resolve) => (fail = resolve));
      throw new Error("ffmpeg died");
    });

    await job.started;
    const reading = collect(readGrowing(job));
    fail();
    expect(reading).rejects.toThrow("ffmpeg died");
  });

  it("reads a job that finished and renamed its file before the reader opened it", async () => {
    const temp = path.join(dir, "quick.tmp");
    const target = path.join(dir, "quick.done");
    const job = new TranscodeJob(temp, target, async (self) => {
      writeFileSync(target, "all of it");
      self.flushed(9);
    });
    await job.finished;

    expect((await collect(readGrowing(job))).toString()).toBe("all of it");
  });
});

describe("ensureVariant", () => {
  it("encodes Opus 160 into an Ogg stream readable while it grows, then caches it", async () => {
    const source = sineFlac(2);
    const cacheDir = path.join(dir, "streams");

    const first = await ensureVariant(HASH, source, "opus160", cacheDir);
    expect(first.kind).toBe("growing");
    if (first.kind !== "growing") return;

    const streamed = await collect(readGrowing(first.job));
    expect(streamed.subarray(0, 4).toString()).toBe("OggS");
    expect(streamed.toString("latin1")).toContain("OpusHead");

    const target = cachePath(HASH, "opus160", cacheDir);
    expect(readFileSync(target).equals(streamed)).toBe(true);
    // No temp left behind next to the finished file.
    expect(readdirSync(path.dirname(target))).toEqual([path.basename(target)]);

    expect(await ensureVariant(HASH, source, "opus160", cacheDir)).toEqual({ kind: "complete", path: target });
  });

  it("encodes AAC as fragmented MP4, with the index up front so it can play before the encode ends", async () => {
    const source = sineFlac(2);
    const variant = await ensureVariant(HASH, source, "aac160", path.join(dir, "streams"));
    if (variant.kind !== "growing") throw new Error("expected a fresh encode");

    const bytes = await collect(readGrowing(variant.job));
    // ftyp, then moov, then fragments: a plain MP4 would put moov last.
    expect(bytes.subarray(4, 8).toString()).toBe("ftyp");
    const moov = bytes.indexOf("moov");
    const moof = bytes.indexOf("moof");
    expect(moov).toBeGreaterThan(0);
    expect(moof).toBeGreaterThan(moov);
  });

  it("shares one encode between two requests for the same track and quality", async () => {
    const source = sineFlac(1);
    const cacheDir = path.join(dir, "streams");

    const [a, b] = await Promise.all([
      ensureVariant(HASH, source, "opus96", cacheDir),
      ensureVariant(HASH, source, "opus96", cacheDir),
    ]);
    if (a.kind !== "growing" || b.kind !== "growing") throw new Error("expected a fresh encode");
    expect(a.job).toBe(b.job);
    await a.job.finished;
  });

  it("rejects `started` for a source ffmpeg can't read, and leaves nothing in the cache", async () => {
    const source = path.join(dir, "not-audio.flac");
    writeFileSync(source, "this is not a flac file");
    const cacheDir = path.join(dir, "streams");

    const variant = await ensureVariant(HASH, source, "opus160", cacheDir);
    if (variant.kind !== "growing") throw new Error("expected a fresh encode");
    expect(variant.job.started).rejects.toThrow("ffmpeg failed to transcode to opus160");
    await variant.job.finished.catch(() => {});

    const shard = path.dirname(cachePath(HASH, "opus160", cacheDir));
    expect(existsSync(shard) ? readdirSync(shard) : []).toEqual([]);
  });
});

describe("stopFfmpeg", () => {
  it("stops an ffmpeg whose output is paused for backpressure", async () => {
    // What a slow disk leaves behind: stdout paused and the pipe full, with
    // ffmpeg blocked writing to it. A plain SIGTERM never ended that one
    // (first seen on CI's Linux runner), so its slot was never given back.
    const ffmpeg = spawn("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=600", "-f", "wav", "pipe:1"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let bytes = 0;
    ffmpeg.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 256 * 1024) ffmpeg.stdout.pause();
    });
    while (!ffmpeg.stdout.isPaused()) await new Promise((resolve) => setTimeout(resolve, 10));
    await new Promise((resolve) => setTimeout(resolve, 100));

    const closed = new Promise<boolean>((resolve) => ffmpeg.once("close", () => resolve(true)));
    stopFfmpeg(ffmpeg);
    const timedOut = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000));
    const stopped = await Promise.race([closed, timedOut]);
    if (!stopped) ffmpeg.kill("SIGKILL");
    expect(stopped).toBe(true);
  });
});
