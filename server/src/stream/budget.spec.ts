import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { noteServed, RECENTLY_SERVED_MS, trimOriginalFmp4 } from "./budget.js";
import { cachePath, ensureVariant } from "./cache.js";

const NOW = Date.parse("2026-10-30T12:00:00Z");
const MINUTE = 60_000;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "legato-stream-budget-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// A cached remux of `bytes` bytes, last served `minutesAgo` before NOW.
// Sparse, so a cap's worth costs the disk nothing.
function remux(hash: string, bytes: number, minutesAgo: number): string {
  const file = cachePath(hash.padEnd(40, "0"), "original-fmp4", dir);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "");
  truncateSync(file, bytes);
  const at = new Date(NOW - minutesAgo * MINUTE);
  utimesSync(file, at, at);
  return file;
}

describe("trimOriginalFmp4", () => {
  it("removes the remuxes served longest ago until the directory is within the cap", async () => {
    const oldest = remux("aa", 400, 300);
    const older = remux("bb", 400, 200);
    const newer = remux("cc", 400, 100);
    const newest = remux("dd", 400, 30);

    const removed = await trimOriginalFmp4({ cacheDir: dir, maxBytes: 900, now: NOW });

    expect(removed).toEqual([oldest, older]);
    for (const file of [newer, newest]) expect(existsSync(file)).toBe(true);
  });

  it("leaves a directory within the cap alone", async () => {
    const files = [remux("aa", 400, 300), remux("bb", 400, 200)];
    expect(await trimOriginalFmp4({ cacheDir: dir, maxBytes: 800, now: NOW })).toEqual([]);
    for (const file of files) expect(existsSync(file)).toBe(true);
  });

  it("keeps anything served in the last ten minutes, the queue being played, even over the cap", async () => {
    const stale = remux("aa", 400, 60);
    const playing = remux("bb", 400, 9);
    const next = remux("cc", 400, 1);

    const removed = await trimOriginalFmp4({ cacheDir: dir, maxBytes: 100, now: NOW });

    expect(removed).toEqual([stale]);
    expect(existsSync(playing)).toBe(true);
    expect(existsSync(next)).toBe(true);
    expect(RECENTLY_SERVED_MS).toBe(10 * MINUTE);
  });

  it("never removes an encode still being written, though its bytes count", async () => {
    const old = remux("aa", 400, 60);
    const writing = `${cachePath("bb".padEnd(40, "0"), "original-fmp4", dir)}.0f0e0d0c.tmp`;
    mkdirSync(path.dirname(writing), { recursive: true });
    writeFileSync(writing, Buffer.alloc(800));
    const at = new Date(NOW - 120 * MINUTE);
    utimesSync(writing, at, at);

    // The finished one alone is within 500 bytes; with the temp file's it isn't.
    expect(await trimOriginalFmp4({ cacheDir: dir, maxBytes: 500, now: NOW })).toEqual([old]);
    expect(existsSync(writing)).toBe(true);
  });

  it("only ever trims the original-fmp4 rung", async () => {
    const aac = cachePath("ee".padEnd(40, "0"), "aac160", dir);
    mkdirSync(path.dirname(aac), { recursive: true });
    writeFileSync(aac, Buffer.alloc(4000));
    const at = new Date(NOW - 600 * MINUTE);
    utimesSync(aac, at, at);
    const remuxed = remux("aa", 400, 300);

    expect(await trimOriginalFmp4({ cacheDir: dir, maxBytes: 1000, now: NOW })).toEqual([]);
    expect(existsSync(aac)).toBe(true);
    expect(existsSync(remuxed)).toBe(true);
  });

  it("reports nothing for a cache that has never had a remux", async () => {
    expect(await trimOriginalFmp4({ cacheDir: path.join(dir, "nothing-here"), maxBytes: 0, now: NOW })).toEqual([]);
  });
});

describe("noteServed", () => {
  it("makes a remux the most recently served, so the budget keeps it", async () => {
    const replayed = remux("aa", 400, 300);
    const other = remux("bb", 400, 200);

    await noteServed(replayed, NOW);

    expect(statSync(replayed).mtimeMs).toBe(NOW);
    expect(await trimOriginalFmp4({ cacheDir: dir, maxBytes: 500, now: NOW + 20 * MINUTE })).toEqual([other]);
  });

  it("doesn't touch a file again within a minute of the last time", async () => {
    const file = remux("aa", 10, 0.5);
    await noteServed(file, NOW);
    expect(statSync(file).mtimeMs).toBe(NOW - 0.5 * MINUTE);
  });

  it("shrugs off a file that's gone", async () => {
    await noteServed(path.join(dir, "gone.m4a"), NOW);
  });
});

describe("a new remux", () => {
  it("trims the rung once it lands, keeping itself", async () => {
    const source = path.join(dir, "source.flac");
    execFileSync("ffmpeg", ["-f", "lavfi", "-i", "sine=frequency=440:duration=1", source], { stdio: "ignore" });
    // A full cap's worth of remuxes nobody has played for hours.
    const stale = remux("aa", 2 * 1024 ** 3, 600);

    const variant = await ensureVariant("ff".padEnd(40, "0"), source, "original-fmp4", dir);
    if (variant.kind === "growing") await variant.job.finished;

    // The trim runs after the rename, off the request.
    for (let i = 0; i < 50 && existsSync(stale); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(cachePath("ff".padEnd(40, "0"), "original-fmp4", dir))).toBe(true);
  });
});
