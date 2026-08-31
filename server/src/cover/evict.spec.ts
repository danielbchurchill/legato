import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { sweepCoverCache } from "./evict.js";

let db: Database.Database;
let dir: string;

beforeEach(() => {
  db = openDb(":memory:");
  dir = mkdtempSync(path.join(tmpdir(), "legato-cover-evict-test-"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function insertLiveHash(hash: string): void {
  const node = db.prepare("INSERT INTO nodes (type, title) VALUES ('release', 'x') RETURNING id").get() as {
    id: number;
  };
  db.prepare("INSERT INTO cover_art (node_id, source, hash) VALUES (?, 'embedded', ?)").run(node.id, hash);
}

// Real cachePath() shape: <dir>/<size>/<hash prefix>/<hash>.jpg
function writeCoverFile(size: string, hash: string): string {
  const full = path.join(dir, size, hash.slice(0, 2), `${hash}.jpg`);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, `cover bytes for ${hash}`);
  return full;
}

describe("sweepCoverCache", () => {
  it("dry-run reports orphans (a hash no cover_art row references) without deleting them", async () => {
    insertLiveHash("live1111111111111111111111111111111111");
    writeCoverFile("256", "live1111111111111111111111111111111111");
    const orphanPath = writeCoverFile("256", "orphan22222222222222222222222222222222");

    const report = await sweepCoverCache(db, { cacheDir: dir });

    expect(report.orphans).toHaveLength(1);
    expect(report.orphans[0].path).toBe(orphanPath);
    expect(report.deleted).toEqual([]);
    expect(existsSync(orphanPath)).toBe(true);
  });

  it("apply mode deletes the orphan and leaves the live hash's file untouched", async () => {
    insertLiveHash("live1111111111111111111111111111111111");
    const livePath = writeCoverFile("256", "live1111111111111111111111111111111111");
    const orphanPath = writeCoverFile("256", "orphan22222222222222222222222222222222");

    await sweepCoverCache(db, { cacheDir: dir, dryRun: false });

    expect(existsSync(livePath)).toBe(true);
    expect(existsSync(orphanPath)).toBe(false);
  });

  it("cleans an orphaned hash out of every size directory it's cached under, not just one", async () => {
    // 256/512 are the live ladder; 128 stands in for a superseded rung a
    // ladder change left behind — sweepCoverCache doesn't special-case
    // either, it walks whatever numeric directories exist.
    const hash = "stale111111111111111111111111111111111";
    const p128 = writeCoverFile("128", hash);
    const p256 = writeCoverFile("256", hash);
    const p512 = writeCoverFile("512", hash);

    const report = await sweepCoverCache(db, { cacheDir: dir, dryRun: false });

    expect(report.deleted.map((d) => d.path).sort()).toEqual([p128, p256, p512].sort());
    expect(existsSync(p128)).toBe(false);
    expect(existsSync(p256)).toBe(false);
    expect(existsSync(p512)).toBe(false);
  });

  it("leaves a live hash's copies alone across every size directory", async () => {
    const hash = "live3333333333333333333333333333333333";
    insertLiveHash(hash);
    const p256 = writeCoverFile("256", hash);
    const p512 = writeCoverFile("512", hash);

    const report = await sweepCoverCache(db, { cacheDir: dir, dryRun: false });

    expect(report.orphans).toEqual([]);
    expect(existsSync(p256)).toBe(true);
    expect(existsSync(p512)).toBe(true);
  });

  it("reports zero orphans for a cache directory that has never been written to", async () => {
    const report = await sweepCoverCache(db, { cacheDir: path.join(dir, "never-created") });
    expect(report.orphans).toEqual([]);
    expect(report.orphanBytes).toBe(0);
  });
});
