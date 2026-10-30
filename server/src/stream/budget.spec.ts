import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { noteServed, RECENTLY_SERVED_MS, trimStreamCache } from "./budget.js";
import { cachePath, ensureVariant } from "./cache.js";
import { VARIANTS, type TranscodedQuality } from "./quality.js";

const NOW = Date.parse("2026-10-30T12:00:00Z");
const MINUTE = 60_000;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "legato-stream-budget-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function age(file: string, minutesAgo: number): string {
  const at = new Date(NOW - minutesAgo * MINUTE);
  utimesSync(file, at, at);
  return file;
}

// A cached file at `quality` of `bytes` bytes, last served `minutesAgo`
// before NOW. Sparse, so a budget's worth costs the disk nothing.
function cached(quality: TranscodedQuality, hash: string, bytes: number, minutesAgo: number): string {
  const file = cachePath(hash.padEnd(40, "0"), quality, dir);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "");
  truncateSync(file, bytes);
  return age(file, minutesAgo);
}

describe("trimStreamCache", () => {
  it("removes the files served longest ago, whichever rung they're in, until the cache is within budget", async () => {
    const remux = cached("original-fmp4", "aa", 400, 300);
    const aac = cached("aac160", "bb", 400, 250);
    const opus = cached("opus96", "cc", 400, 200);
    const newerRemux = cached("original-fmp4", "dd", 400, 100);
    const newerAac = cached("aac256", "ee", 400, 50);
    const newest = cached("opus160", "ff", 400, 30);

    const { removed, removedBytes, totalBytes } = await trimStreamCache({ cacheDir: dir, maxBytes: 1300, now: NOW });

    expect(removed).toEqual([remux, aac, opus]);
    expect(removedBytes).toBe(1200);
    expect(totalBytes).toBe(1200);
    for (const file of [newerRemux, newerAac, newest]) expect(existsSync(file)).toBe(true);
  });

  it("counts every rung towards the one budget", async () => {
    const files = (Object.keys(VARIANTS) as TranscodedQuality[]).map((quality, i) => cached(quality, "aa", 100, 600 - i));
    // Six rungs of 100 bytes each, one more than 500 holds.
    expect((await trimStreamCache({ cacheDir: dir, maxBytes: 500, now: NOW })).removed).toEqual([files[0]]);
  });

  it("leaves a cache within budget alone", async () => {
    const files = [cached("original-fmp4", "aa", 400, 300), cached("aac160", "bb", 400, 200)];
    expect(await trimStreamCache({ cacheDir: dir, maxBytes: 800, now: NOW })).toEqual({
      removed: [],
      removedBytes: 0,
      totalBytes: 800,
    });
    for (const file of files) expect(existsSync(file)).toBe(true);
  });

  it("keeps anything served in the last ten minutes, the queue being played, even over budget", async () => {
    const stale = cached("aac160", "aa", 400, 60);
    const playing = cached("original-fmp4", "bb", 400, 9);
    const next = cached("opus160", "cc", 400, 1);

    const { removed, totalBytes } = await trimStreamCache({ cacheDir: dir, maxBytes: 100, now: NOW });

    expect(removed).toEqual([stale]);
    expect(totalBytes).toBe(800);
    expect(existsSync(playing)).toBe(true);
    expect(existsSync(next)).toBe(true);
    expect(RECENTLY_SERVED_MS).toBe(10 * MINUTE);
  });

  it("never removes an encode still being written, in any rung, though its bytes count", async () => {
    const old = cached("original-fmp4", "aa", 400, 60);
    const writing = [
      `${cachePath("bb".padEnd(40, "0"), "aac160", dir)}.0f0e0d0c.tmp`,
      `${cachePath("cc".padEnd(40, "0"), "opus96", dir)}.0a0b0c0d.tmp`,
    ];
    for (const file of writing) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, Buffer.alloc(400));
      age(file, 120);
    }

    // The finished one alone is within 500 bytes; with the temp files' it isn't.
    expect((await trimStreamCache({ cacheDir: dir, maxBytes: 500, now: NOW })).removed).toEqual([old]);
    for (const file of writing) expect(existsSync(file)).toBe(true);
  });

  it("keeps a file a request served after the trim listed it", async () => {
    const replayed = cached("aac160", "aa", 400, 300);
    const other = cached("opus96", "bb", 400, 200);
    const realStat = fsPromises.stat;
    let listed = false;
    const serving = spyOn(fsPromises, "stat").mockImplementation((async (...args: Parameters<typeof realStat>) => {
      const info = await realStat(...args);
      // A request serves it just after the listing has read its time.
      if (args[0] === replayed && !listed) {
        listed = true;
        await noteServed(replayed, NOW + MINUTE);
      }
      return info;
    }) as typeof realStat);
    try {
      expect((await trimStreamCache({ cacheDir: dir, maxBytes: 500, now: NOW + 2 * MINUTE })).removed).toEqual([other]);
    } finally {
      serving.mockRestore();
    }
    expect(listed).toBe(true);
    expect(existsSync(replayed)).toBe(true);
  });

  it("leaves what isn't a rung's alone: the pre-#120 layout, unknown directories, stray files", async () => {
    const strays = [
      path.join(dir, "aa", "aa".padEnd(40, "0") + ".flac"),
      path.join(dir, "flac", "aa", "aa".padEnd(40, "0") + ".flac"),
      path.join(dir, "notes.txt"),
    ];
    for (const file of strays) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, Buffer.alloc(4000));
      age(file, 6000);
    }
    const kept = cached("aac160", "bb", 400, 300);

    expect(await trimStreamCache({ cacheDir: dir, maxBytes: 1000, now: NOW })).toEqual({
      removed: [],
      removedBytes: 0,
      totalBytes: 400,
    });
    for (const file of [...strays, kept]) expect(existsSync(file)).toBe(true);
  });

  it("reports nothing for a cache that has never had a transcode", async () => {
    expect((await trimStreamCache({ cacheDir: path.join(dir, "nothing-here"), maxBytes: 0, now: NOW })).removed).toEqual([]);
  });
});

describe("noteServed", () => {
  it("makes a file the most recently served, so the budget keeps it", async () => {
    const replayed = cached("opus160", "aa", 400, 300);
    const other = cached("aac160", "bb", 400, 200);

    await noteServed(replayed, NOW);

    expect(statSync(replayed).mtimeMs).toBe(NOW);
    expect((await trimStreamCache({ cacheDir: dir, maxBytes: 500, now: NOW + 20 * MINUTE })).removed).toEqual([other]);
  });

  it("doesn't touch a file again within a minute of the last time", async () => {
    const file = cached("original-fmp4", "aa", 10, 0.5);
    await noteServed(file, NOW);
    expect(statSync(file).mtimeMs).toBe(NOW - 0.5 * MINUTE);
  });

  it("shrugs off a file that's gone", async () => {
    await noteServed(path.join(dir, "gone.m4a"), NOW);
  });
});

describe("a new transcode", () => {
  const source = () => {
    const file = path.join(dir, "source.flac");
    if (!existsSync(file)) {
      execFileSync("ffmpeg", ["-f", "lavfi", "-i", "sine=frequency=440:duration=1", file], { stdio: "ignore" });
    }
    return file;
  };

  for (const quality of ["original-fmp4", "aac160", "opus96"] as const) {
    it(`trims the cache once a ${quality} file lands, keeping itself`, async () => {
      // More than the default budget, in a rung nobody has played for hours.
      const stale = cached("aac256", "aa", 4 * 1024 ** 3 + 1, 600);

      const variant = await ensureVariant("ff".padEnd(40, "0"), source(), quality, dir);
      if (variant.kind === "growing") await variant.job.finished;

      // The trim runs after the rename, off the request.
      for (let i = 0; i < 50 && existsSync(stale); i++) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(cachePath("ff".padEnd(40, "0"), quality, dir))).toBe(true);
    });
  }
});
