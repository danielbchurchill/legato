import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Database } from "../sqlite.js";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { openDb } from "../db.js";
import { cachePath } from "./cache.js";
import { streamCacheHash, sweepStreamCache } from "./evict.js";
import type { TranscodedQuality } from "./quality.js";

let db: Database;
let dir: string;

beforeEach(() => {
  db = openDb(":memory:");
  dir = mkdtempSync(path.join(tmpdir(), "legato-stream-evict-test-"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

let fileCounter = 0;

function insertLiveFileHash(hash: string): void {
  const root = db.prepare("INSERT INTO library_roots (path) VALUES (?) RETURNING id").get(dir) as { id: number };
  const node = db.prepare("INSERT INTO nodes (type, title) VALUES ('recording', 'x') RETURNING id").get() as {
    id: number;
  };
  db.prepare("INSERT INTO recordings (node_id) VALUES (?)").run(node.id);
  db.prepare(
    `INSERT INTO files (recording_node_id, library_root_id, file_path, file_mtime, file_size, file_hash)
     VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z', 0, ?)`,
  ).run(node.id, root.id, path.join(dir, `track-${fileCounter++}.flac`), hash);
}

// Real cache.ts cachePath() shape: <dir>/<quality>/<hash prefix>/<hash>.<ext>
function writeStreamFile(hash: string, quality: TranscodedQuality = "opus160"): string {
  const full = cachePath(hash, quality, dir);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, `flac bytes for ${hash}`);
  return full;
}

describe("sweepStreamCache", () => {
  it("dry-run reports a transcode with no matching files.file_hash as an orphan, without deleting it", async () => {
    insertLiveFileHash("live1111111111111111111111111111111111");
    writeStreamFile("live1111111111111111111111111111111111");
    const orphanPath = writeStreamFile("orphan22222222222222222222222222222222");

    const report = await sweepStreamCache(db, { cacheDir: dir });

    expect(report.orphans).toHaveLength(1);
    expect(report.orphans[0].path).toBe(orphanPath);
    expect(report.deleted).toEqual([]);
    expect(existsSync(orphanPath)).toBe(true);
  });

  it("apply mode deletes only the orphan, leaving the live-hash transcode in place", async () => {
    insertLiveFileHash("live1111111111111111111111111111111111");
    const livePath = writeStreamFile("live1111111111111111111111111111111111");
    const orphanPath = writeStreamFile("orphan22222222222222222222222222222222");

    const report = await sweepStreamCache(db, { cacheDir: dir, dryRun: false });

    expect(report.deleted.map((d) => d.path)).toEqual([orphanPath]);
    expect(existsSync(livePath)).toBe(true);
    expect(existsSync(orphanPath)).toBe(false);
  });

  it("treats files.file_hash IS NULL rows as not live, matching the query's own WHERE clause", async () => {
    const root = db.prepare("INSERT INTO library_roots (path) VALUES (?) RETURNING id").get(dir) as { id: number };
    const node = db.prepare("INSERT INTO nodes (type, title) VALUES ('recording', 'x') RETURNING id").get() as {
      id: number;
    };
    db.prepare("INSERT INTO recordings (node_id) VALUES (?)").run(node.id);
    db.prepare(
      `INSERT INTO files (recording_node_id, library_root_id, file_path, file_mtime, file_size, file_hash)
       VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z', 0, NULL)`,
    ).run(node.id, root.id, path.join(dir, "unhashed.flac"));

    const report = await sweepStreamCache(db, { cacheDir: dir });
    expect(report.liveHashCount).toBe(0);
  });

  it("reports zero orphans for a cache directory that has never been written to", async () => {
    const report = await sweepStreamCache(db, { cacheDir: path.join(dir, "never-created") });
    expect(report.orphans).toEqual([]);
    expect(report.orphanBytes).toBe(0);
  });

  it("keeps every quality of a live hash and removes every quality of an orphan", async () => {
    insertLiveFileHash("live1111111111111111111111111111111111");
    const live = (["opus96", "opus160", "opus256", "aac160", "aac256"] as const).map((q) =>
      writeStreamFile("live1111111111111111111111111111111111", q),
    );
    const orphans = [
      writeStreamFile("orphan22222222222222222222222222222222", "opus256"),
      writeStreamFile("orphan22222222222222222222222222222222", "aac160"),
    ];

    const report = await sweepStreamCache(db, { cacheDir: dir, dryRun: false });

    expect(report.deleted.map((d) => d.path).sort()).toEqual(orphans.sort());
    for (const file of live) expect(existsSync(file)).toBe(true);
  });

  it("removes the pre-#120 flat <prefix>/<hash>.flac layout even for a live hash", async () => {
    insertLiveFileHash("live1111111111111111111111111111111111");
    const legacy = path.join(dir, "li", "live1111111111111111111111111111111111.flac");
    mkdirSync(path.dirname(legacy), { recursive: true });
    writeFileSync(legacy, "old flac re-encode");

    const report = await sweepStreamCache(db, { cacheDir: dir, dryRun: false });

    expect(report.deleted.map((d) => d.path)).toEqual([legacy]);
  });

  it("leaves temp files, unknown rung directories and wrong extensions alone", async () => {
    const files = [
      path.join(dir, "opus160", "or", "orphan22222222222222222222222222222222.opus.0f3a.tmp"),
      path.join(dir, "flac", "or", "orphan22222222222222222222222222222222.flac"),
      path.join(dir, "opus160", "or", "orphan22222222222222222222222222222222.m4a"),
      path.join(dir, "notes.txt"),
    ];
    for (const file of files) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, "not a cache blob");
    }

    const report = await sweepStreamCache(db, { cacheDir: dir, dryRun: false });

    expect(report.orphans).toEqual([]);
    for (const file of files) expect(existsSync(file)).toBe(true);
  });
});

describe("streamCacheHash", () => {
  it("never claims a path outside the cache directory", () => {
    const outside = path.join(path.dirname(dir), "elsewhere", "op", "opus160", "ab", "abc.opus");
    expect(streamCacheHash(dir, outside)).toBeNull();
    expect(streamCacheHash(dir, path.join(dir, "..", "ab", "abc.flac"))).toBeNull();
  });

  it("reads the hash back out of a variant path", () => {
    expect(streamCacheHash(dir, cachePath("abcdef", "aac256", dir))).toBe("abcdef");
  });
});
