import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { sweepStreamCache } from "./evict.js";

let db: Database.Database;
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

// Real cache.ts cachePath() shape: <dir>/<hash prefix>/<hash>.flac
function writeStreamFile(hash: string): string {
  const full = path.join(dir, hash.slice(0, 2), `${hash}.flac`);
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
});
