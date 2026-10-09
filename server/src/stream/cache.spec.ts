import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { appendFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mediaSlotsInUse, playbackWaiting } from "../media/queue.js";
import { fillMediaSlots, queuePlayback } from "../media/test-slots.js";
import { cachePath, ensureVariant, Orphans, readGrowing, stopFfmpeg, TranscodeJob } from "./cache.js";

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
function sineFlac(seconds: number, name = "source.flac"): string {
  const source = path.join(dir, name);
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

  it("kills a process that ignores SIGTERM once it has had a few seconds", async () => {
    // An ffmpeg stuck reading a source on a hung network mount sits on
    // SIGTERM, and its media-queue slot with it: with a concurrency of 1
    // or 2, every stream after it would queue for ever.
    const stuck = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); console.error("ready")'], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await new Promise((resolve) => stuck.stderr.once("data", resolve));
      const closed = new Promise<NodeJS.Signals | null>((resolve) => stuck.once("close", (_code, signal) => resolve(signal)));
      stopFfmpeg(stuck, 300);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(stuck.exitCode).toBeNull();
      expect(stuck.signalCode).toBeNull();
      const timedOut = new Promise<string>((resolve) => setTimeout(() => resolve("still running"), 2_000));
      expect(await Promise.race([closed, timedOut])).toBe("SIGKILL");
    } finally {
      stuck.kill("SIGKILL");
    }
  });
});

describe("TranscodeJob listeners", () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  // Stands in for the media queue's playback waiters: wait() is a track
  // starting to wait for a slot, given() one being handed a slot.
  function demand() {
    let waiting = 0;
    const listeners = new Set<() => void>();
    return {
      waiting: () => waiting,
      onWaiting: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      wait: () => {
        waiting += 1;
        for (const listener of listeners) listener();
      },
      given: () => (waiting -= 1),
    };
  }

  // A job that runs until it's abandoned or told to finish, with ffmpeg
  // started unless `queued`.
  let jobs = 0;
  function job(orphans: Orphans, { queued = false } = {}) {
    let finish!: () => void;
    jobs += 1;
    const made = new TranscodeJob(
      path.join(dir, `job-${jobs}.tmp`),
      path.join(dir, `job-${jobs}.done`),
      (self) =>
        new Promise<void>((resolve, reject) => {
          finish = resolve;
          if (!queued) self.encoding();
          self.abandoned.addEventListener("abort", () => reject(self.abandoned.reason));
        }),
      orphans,
    );
    return { job: made, finish: () => finish() };
  }

  it("runs to the end once its last listener leaves, while no track is waiting for a slot", async () => {
    // A paused player whose browser dropped the idle connection: on resume
    // it asks for the rest, and a finished file answers at once.
    const { job: encode, finish } = job(new Orphans(demand()));
    encode.join()();
    await sleep(50);
    expect(encode.abandoned.aborted).toBe(false);
    finish();
    await encode.finished;
    expect(encode.state).toBe("done");
  });

  it("gives its slot up as soon as a track starts waiting for one, or at once if one already is", async () => {
    const slots = demand();
    const orphans = new Orphans(slots);
    const { job: first } = job(orphans);
    first.join()();
    slots.wait();
    expect(first.abandoned.aborted).toBe(true);
    await expect(first.finished).rejects.toThrow("nobody was listening");
    slots.given();

    slots.wait();
    const { job: second } = job(orphans);
    const leave = second.join();
    expect(second.abandoned.aborted).toBe(false);
    leave();
    expect(second.abandoned.aborted).toBe(true);
  });

  it("gives up one encode for each track waiting, the one nobody has listened to longest first", async () => {
    const slots = demand();
    const orphans = new Orphans(slots);
    const [a, b, c] = [job(orphans), job(orphans), job(orphans)];
    for (const { job: encode } of [a!, b!, c!]) encode.join()();

    slots.wait();
    expect([a!, b!, c!].map(({ job: encode }) => encode.abandoned.aborted)).toEqual([true, false, false]);
    // The track is still waiting, for the slot a's ffmpeg hasn't let go of
    // yet: nothing more goes for it. The queue hands that slot over as soon
    // as ffmpeg exits, before the job itself has settled.
    slots.wait();
    slots.given();
    expect(b!.job.abandoned.aborted).toBe(true);
    slots.given();
    await sleep(10);
    expect(c!.job.abandoned.aborted).toBe(false);

    slots.wait();
    slots.given();
    expect(c!.job.abandoned.aborted).toBe(true);
    await Promise.allSettled([a!, b!, c!].map(({ job: encode }) => encode.finished));
  });

  it("keeps an encode someone still listens to, or came back to, as Safari's reopen does", async () => {
    const slots = demand();
    const orphans = new Orphans(slots);
    const { job: shared, finish: finishShared } = job(orphans);
    const first = shared.join();
    shared.join();
    first();
    // Leaving twice counts once.
    first();
    const { job: reopened, finish: finishReopened } = job(orphans);
    reopened.join()();
    reopened.join();

    slots.wait();
    expect(shared.abandoned.aborted).toBe(false);
    expect(reopened.abandoned.aborted).toBe(false);
    finishShared();
    finishReopened();
    await Promise.all([shared.finished, reopened.finished]);
  });

  it("abandons an encode still waiting for a slot as soon as its last listener leaves", async () => {
    const { job: queued } = job(new Orphans(demand()), { queued: true });
    queued.join()();
    expect(queued.abandoned.aborted).toBe(true);
    await expect(queued.finished).rejects.toThrow("nobody was listening");
  });

  it("is never abandoned once ffmpeg has exited, or if nobody ever listened", async () => {
    const slots = demand();
    const orphans = new Orphans(slots);
    const { job: unheard, finish: finishUnheard } = job(orphans);
    const { job: finishing, finish } = job(orphans);
    const leave = finishing.join();
    finishing.finishing();
    leave();

    slots.wait();
    slots.wait();
    expect(unheard.abandoned.aborted).toBe(false);
    expect(finishing.abandoned.aborted).toBe(false);
    finishUnheard();
    finish();
    await Promise.all([unheard.finished, finishing.finished]);
  });

  it("isn't abandoned once ffmpeg has exited, so nothing encodes it again while its file is finished", async () => {
    // ffmpeg has written the whole file and exited, and the rename into
    // place is held back: the window a track starting to wait can land in.
    const source = sineFlac(1, "short.flac");
    const cacheDir = path.join(dir, "streams");
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const rename = fsPromises.rename;
    const renaming = spyOn(fsPromises, "rename").mockImplementation(async (...args: Parameters<typeof rename>) => {
      await held;
      return rename(...args);
    });
    let full: { release(): void } | undefined;
    let waiting: { granted: Promise<void>; release(): void } | undefined;
    try {
      const first = await ensureVariant(HASH, source, "opus160", cacheDir);
      if (first.kind !== "growing") throw new Error("expected a fresh encode");
      const leave = first.job.join();
      while (renaming.mock.calls.length === 0) await sleep(5);
      leave();
      full = fillMediaSlots();
      waiting = queuePlayback();
      await sleep(20);

      const second = await ensureVariant(HASH, source, "opus160", cacheDir);
      expect(second.kind === "growing" && second.job === first.job).toBe(true);
      release();
      await first.job.finished;
      expect(existsSync(cachePath(HASH, "opus160", cacheDir))).toBe(true);
    } finally {
      release();
      renaming.mockRestore();
      full?.release();
      await waiting?.granted;
      waiting?.release();
    }
  });

  it("kills ffmpeg, removes its temp file and gives its slot to the track waiting, and the next request encodes afresh", async () => {
    // Twenty minutes of audio: a few seconds of encoding, so it's still
    // going when its listener leaves.
    const source = sineFlac(1200, "long.flac");
    const cacheDir = path.join(dir, "streams");
    const shard = path.dirname(cachePath(HASH, "opus160", cacheDir));

    const variant = await ensureVariant(HASH, source, "opus160", cacheDir);
    if (variant.kind !== "growing") throw new Error("expected a fresh encode");
    const leave = variant.job.join();
    await variant.job.started;
    leave();
    // Nobody waiting for a slot: it carries on.
    await sleep(100);
    expect(variant.job.abandoned.aborted).toBe(false);

    const full = fillMediaSlots();
    const next = queuePlayback();
    try {
      await expect(variant.job.finished).rejects.toThrow("nobody was listening");
      await next.granted;
      expect(existsSync(shard) ? readdirSync(shard) : []).toEqual([]);
    } finally {
      next.release();
      full.release();
    }

    // Not the dying job: a new one, which runs to the end and is cached.
    const short = sineFlac(1, "short.flac");
    const again = await ensureVariant(HASH, short, "opus160", cacheDir);
    if (again.kind !== "growing") throw new Error("expected a fresh encode");
    expect(again.job).not.toBe(variant.job);
    await collect(readGrowing(again.job));
    expect(readdirSync(shard)).toEqual([path.basename(cachePath(HASH, "opus160", cacheDir))]);
  });

  it("takes a track skipped while it waited for a slot out of the queue", async () => {
    const source = sineFlac(1, "short.flac");
    const cacheDir = path.join(dir, "streams");
    const full = fillMediaSlots();
    try {
      const variant = await ensureVariant(HASH, source, "opus160", cacheDir);
      if (variant.kind !== "growing") throw new Error("expected a fresh encode");
      const leave = variant.job.join();
      await sleep(20);
      expect(playbackWaiting()).toBe(1);
      leave();
      expect(playbackWaiting()).toBe(0);
      await expect(variant.job.finished).rejects.toThrow("nobody was listening");
    } finally {
      full.release();
    }
    // Nothing started when the slots came free.
    await sleep(50);
    expect(mediaSlotsInUse()).toBe(0);
    expect(readdirSync(path.dirname(cachePath(HASH, "opus160", cacheDir)))).toEqual([]);
  });
});
