import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "../db.js";
import { dbInspectorSnapshot } from "./db-inspector.js";

let db: Database.Database;

beforeEach(() => {
  db = openDb(":memory:");
});

function makeNode(type: string, title: string, mbid: string | null = null): number {
  return (
    db.prepare("INSERT INTO nodes (type, title, mbid) VALUES (?, ?, ?) RETURNING id").get(type, title, mbid) as {
      id: number;
    }
  ).id;
}

function makeFile(nodeId: number, filePath: string, matchSource: string, missingSince: string | null = null): number {
  const rootId = (
    db.prepare("INSERT INTO library_roots (path) VALUES (?) RETURNING id").get(`/fake/${filePath}`) as { id: number }
  ).id;
  return (
    db
      .prepare(
        `INSERT INTO files (recording_node_id, library_root_id, file_path, file_mtime, file_size, match_source, missing_since)
         VALUES (?, ?, ?, datetime('now'), 1234, ?, ?) RETURNING id`,
      )
      .get(nodeId, rootId, filePath, matchSource, missingSince) as { id: number }
  ).id;
}

describe("dbInspectorSnapshot", () => {
  it("reports zeroed sections for a fresh, empty library", () => {
    const tmpDbPath = path.join(mkdtempSync(path.join(tmpdir(), "legato-db-inspector-")), "legato.db");
    const coverDir = mkdtempSync(path.join(tmpdir(), "legato-covers-"));

    const snapshot = dbInspectorSnapshot(db, tmpDbPath, coverDir);

    expect(snapshot.pipeline).toEqual({ latestScan: null, enrichJobs: [] });
    expect(snapshot.matchQuality).toEqual([]);
    expect(snapshot.schema).toEqual({
      nodesByType: [],
      edgesByType: [],
      files: 0,
      plays: 0,
      articles: 0,
      fieldProvenance: 0,
      coverArt: 0,
      mergeOverrides: 0,
      tagWrites: 0,
    });
    expect(snapshot.storage).toEqual({ dbBytes: 0, coverCache: { fileCount: 0, totalBytes: 0 } });
  });

  it("aggregates pipeline, match quality, and schema counts from seeded rows", () => {
    const rootId = (
      db.prepare("INSERT INTO library_roots (path) VALUES ('/mnt/music') RETURNING id").get() as { id: number }
    ).id;
    db.prepare(
      `INSERT INTO scan_jobs (library_root_id, status, files_scanned, files_added, files_updated, files_missing, started_at, finished_at)
       VALUES (?, 'done', 10, 3, 2, 1, '2026-08-01 00:00:00', '2026-08-01 00:05:00')`,
    ).run(rootId);
    db.prepare(
      `INSERT INTO scan_jobs (library_root_id, status, files_scanned, files_added, files_updated, files_missing, started_at, finished_at)
       VALUES (?, 'done', 20, 5, 4, 0, '2026-08-02 00:00:00', '2026-08-02 00:05:00')`,
    ).run(rootId);

    db.prepare("INSERT INTO enrich_jobs (job_type, status) VALUES ('recording_lookup', 'done')").run();
    db.prepare("INSERT INTO enrich_jobs (job_type, status) VALUES ('recording_lookup', 'done')").run();
    db.prepare("INSERT INTO enrich_jobs (job_type, status) VALUES ('cover_art_lookup', 'queued')").run();

    const artist = makeNode("artist", "Some Artist", "mbid-1");
    const recA = makeNode("recording", "Track A");
    const recB = makeNode("recording", "Track B");
    const recC = makeNode("recording", "Track C");
    makeFile(recA, "/fake/a.flac", "mbid");
    makeFile(recB, "/fake/b.flac", "fuzzy_pending");
    makeFile(recC, "/fake/c.flac", "unmatched");
    // A missing file should be excluded from match-quality's live scope.
    makeFile(recA, "/fake/gone.flac", "mbid", "2026-08-01 00:00:00");

    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'performed_by', 'local')").run(
      recA,
      artist,
    );

    const tmpDbPath = path.join(mkdtempSync(path.join(tmpdir(), "legato-db-inspector-")), "legato.db");
    writeFileSync(tmpDbPath, Buffer.alloc(4096));
    const coverDir = mkdtempSync(path.join(tmpdir(), "legato-covers-"));
    mkdirSync(path.join(coverDir, "256", "ab"), { recursive: true });
    writeFileSync(path.join(coverDir, "256", "ab", "abcd1234.jpg"), Buffer.alloc(2048));
    mkdirSync(path.join(coverDir, "512", "cd"), { recursive: true });
    writeFileSync(path.join(coverDir, "512", "cd", "cdef5678.jpg"), Buffer.alloc(1024));

    const snapshot = dbInspectorSnapshot(db, tmpDbPath, coverDir);

    expect(snapshot.pipeline.latestScan).toMatchObject({
      status: "done",
      filesScanned: 20,
      filesAdded: 5,
      filesUpdated: 4,
      filesMissing: 0,
    });
    expect(snapshot.pipeline.enrichJobs.sort((a, b) => a.status.localeCompare(b.status))).toEqual([
      { status: "done", count: 2 },
      { status: "queued", count: 1 },
    ]);

    expect(snapshot.matchQuality.sort((a, b) => a.source.localeCompare(b.source))).toEqual([
      { source: "fuzzy_pending", count: 1, share: 1 / 3 },
      { source: "mbid", count: 1, share: 1 / 3 },
      { source: "unmatched", count: 1, share: 1 / 3 },
    ]);

    expect(snapshot.schema.nodesByType.sort((a, b) => a.type.localeCompare(b.type))).toEqual([
      { type: "artist", count: 1 },
      { type: "recording", count: 3 },
    ]);
    expect(snapshot.schema.edgesByType).toEqual([{ type: "performed_by", count: 1 }]);
    expect(snapshot.schema.files).toBe(4);

    expect(snapshot.storage.dbBytes).toBe(4096);
    expect(snapshot.storage.coverCache).toEqual({ fileCount: 2, totalBytes: 3072 });
  });
});
