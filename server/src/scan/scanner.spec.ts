import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "../db.js";
import { markMissing, rescanNode, runFullScan, runIncrementalScan, scanFile } from "./scanner.js";

// A minimal-but-valid 44-byte-header WAV (silence) — enough for
// music-metadata to report format/duration without needing a real codec or
// a checked-in binary fixture.
function writeSilentWav(filePath: string, seconds = 1, sampleRate = 8000) {
  const numSamples = seconds * sampleRate;
  const dataSize = numSamples * 2; // 16-bit mono
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  writeFileSync(filePath, buffer);
}

// walkLibraryRoot (fast-glob under `absolute: true`) always normalizes
// returned paths to forward slashes, even on Windows — fast-glob's own
// entry transformer calls unixify() unconditionally, not just when
// running on a POSIX host. A row that entered the DB through a full or
// incremental scan is keyed on that forward-slash form, so a lookup built
// from a plain path.join (native separators — backslashes on Windows) has
// to be normalized the same way before it'll match. Only needed for rows
// that went through a scan; scanFile() called directly with a path.join
// string (elsewhere in this file) stores that exact string, so no
// mismatch there.
function toScannedPath(p: string): string {
  return p.replace(/\\/g, "/");
}

let db: Database.Database;
let dir: string;
let libraryRootId: number;

beforeEach(() => {
  db = openDb(":memory:");
  dir = mkdtempSync(path.join(tmpdir(), "legato-scan-test-"));
  const row = db
    .prepare("INSERT INTO library_roots (path) VALUES (?) RETURNING id")
    .get(dir) as { id: number };
  libraryRootId = row.id;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("scanFile", () => {
  it("inserts a provisional node/recording/file, unmatched, on first sight", async () => {
    const filePath = path.join(dir, "track.wav");
    writeSilentWav(filePath);

    const outcome = await scanFile(db, libraryRootId, filePath);
    expect(outcome).toBe("added");

    const file = db.prepare("SELECT * FROM files WHERE file_path = ?").get(filePath) as {
      match_source: string;
      format: string | null;
      recording_node_id: number;
    };
    expect(file.match_source).toBe("unmatched");
    expect(file.format).toBeTruthy();

    const node = db.prepare("SELECT * FROM nodes WHERE id = ?").get(file.recording_node_id) as {
      type: string;
    };
    expect(node.type).toBe("recording");
  });

  it("is a no-op for an unchanged file on re-scan", async () => {
    const filePath = path.join(dir, "track.wav");
    writeSilentWav(filePath);
    await scanFile(db, libraryRootId, filePath);

    const outcome = await scanFile(db, libraryRootId, filePath);
    expect(outcome).toBe("unchanged");
  });

  it("re-parses and updates when the file changes", async () => {
    const filePath = path.join(dir, "track.wav");
    writeSilentWav(filePath, 1);
    await scanFile(db, libraryRootId, filePath);

    writeSilentWav(filePath, 2); // different size/duration
    const outcome = await scanFile(db, libraryRootId, filePath);
    expect(outcome).toBe("updated");

    const file = db.prepare("SELECT duration_ms FROM files WHERE file_path = ?").get(filePath) as {
      duration_ms: number;
    };
    expect(file.duration_ms).toBeGreaterThan(1500);
  });
});

describe("markMissing", () => {
  it("marks a file missing without deleting its row", async () => {
    const filePath = path.join(dir, "track.wav");
    writeSilentWav(filePath);
    await scanFile(db, libraryRootId, filePath);

    markMissing(db, filePath);

    const file = db.prepare("SELECT id, missing_since FROM files WHERE file_path = ?").get(filePath) as {
      id: number;
      missing_since: string | null;
    };
    expect(file.id).toBeTruthy();
    expect(file.missing_since).toBeTruthy();
  });

  it("is idempotent — doesn't overwrite an existing missing_since", async () => {
    const filePath = path.join(dir, "track.wav");
    writeSilentWav(filePath);
    await scanFile(db, libraryRootId, filePath);

    markMissing(db, filePath);
    const first = (
      db.prepare("SELECT missing_since FROM files WHERE file_path = ?").get(filePath) as {
        missing_since: string;
      }
    ).missing_since;

    markMissing(db, filePath);
    const second = (
      db.prepare("SELECT missing_since FROM files WHERE file_path = ?").get(filePath) as {
        missing_since: string;
      }
    ).missing_since;

    expect(second).toBe(first);
  });
});

describe("rescanNode", () => {
  it("re-derives a node's file and reports the outcome", async () => {
    const filePath = path.join(dir, "track.wav");
    writeSilentWav(filePath, 1);
    await scanFile(db, libraryRootId, filePath);
    const file = db.prepare("SELECT id, recording_node_id FROM files WHERE file_path = ?").get(filePath) as {
      id: number;
      recording_node_id: number;
    };

    writeSilentWav(filePath, 2); // different size/duration, same as scanFile's own "updated" test
    const results = await rescanNode(db, file.recording_node_id);

    expect(results).toEqual([{ fileId: file.id, filePath, outcome: "updated" }]);
    const updated = db.prepare("SELECT duration_ms FROM files WHERE id = ?").get(file.id) as {
      duration_ms: number;
    };
    expect(updated.duration_ms).toBeGreaterThan(1500);
  });

  it("rescans every file for a node with more than one file (a merge)", async () => {
    const pathA = path.join(dir, "a.wav");
    const pathB = path.join(dir, "b.wav");
    writeSilentWav(pathA, 1);
    writeSilentWav(pathB, 1);
    await scanFile(db, libraryRootId, pathA);
    await scanFile(db, libraryRootId, pathB);
    const fileA = db.prepare("SELECT id, recording_node_id FROM files WHERE file_path = ?").get(pathA) as {
      id: number;
      recording_node_id: number;
    };
    const fileB = db.prepare("SELECT id FROM files WHERE file_path = ?").get(pathB) as { id: number };
    // Simulate the merge InstancesList (MetadataFields.tsx) renders: two
    // files sharing one recording node, same as match/collapse.ts produces
    // for a real duplicate.
    db.prepare("UPDATE files SET recording_node_id = ? WHERE id = ?").run(fileA.recording_node_id, fileB.id);

    writeSilentWav(pathA, 2);
    writeSilentWav(pathB, 2);
    const results = await rescanNode(db, fileA.recording_node_id);

    expect(results).toHaveLength(2);
    expect(results).toEqual(
      expect.arrayContaining([
        { fileId: fileA.id, filePath: pathA, outcome: "updated" },
        { fileId: fileB.id, filePath: pathB, outcome: "updated" },
      ]),
    );
  });

  it("marks a file missing, rather than throwing, when it's vanished from disk since its row was written", async () => {
    const filePath = path.join(dir, "track.wav");
    writeSilentWav(filePath);
    await scanFile(db, libraryRootId, filePath);
    const file = db.prepare("SELECT id, recording_node_id FROM files WHERE file_path = ?").get(filePath) as {
      id: number;
      recording_node_id: number;
    };

    rmSync(filePath);
    const results = await rescanNode(db, file.recording_node_id);

    expect(results).toEqual([{ fileId: file.id, filePath, outcome: "missing" }]);
    const row = db.prepare("SELECT missing_since FROM files WHERE id = ?").get(file.id) as {
      missing_since: string | null;
    };
    expect(row.missing_since).toBeTruthy();
  });

  it("returns an empty list for a node with no files", async () => {
    const artist = db.prepare("INSERT INTO nodes (type, title) VALUES ('artist', 'Some Artist') RETURNING id").get() as {
      id: number;
    };
    expect(await rescanNode(db, artist.id)).toEqual([]);
  });
});

describe("runFullScan", () => {
  it("walks a directory, tallies additions, and marks removed files missing (not deleted)", async () => {
    writeSilentWav(path.join(dir, "a.wav"));
    writeSilentWav(path.join(dir, "b.wav"));

    const jobId = await runFullScan(db, libraryRootId, dir);
    const job = db.prepare("SELECT * FROM scan_jobs WHERE id = ?").get(jobId) as {
      status: string;
      files_scanned: number;
      files_added: number;
    };
    expect(job.status).toBe("done");
    expect(job.files_scanned).toBe(2);
    expect(job.files_added).toBe(2);

    rmSync(path.join(dir, "a.wav"));
    const jobId2 = await runFullScan(db, libraryRootId, dir);
    const job2 = db.prepare("SELECT * FROM scan_jobs WHERE id = ?").get(jobId2) as {
      files_missing: number;
    };
    expect(job2.files_missing).toBe(1);

    const totalRows = db.prepare("SELECT COUNT(*) AS n FROM files").get() as { n: number };
    expect(totalRows.n).toBe(2); // still 2 — the missing file wasn't deleted
  });

  it("a no-op re-scan doesn't touch unchanged rows", async () => {
    writeSilentWav(path.join(dir, "a.wav"));
    await runFullScan(db, libraryRootId, dir);
    const before = db.prepare("SELECT last_seen_at FROM files").get() as { last_seen_at: string };

    await new Promise((resolve) => setTimeout(resolve, 1100)); // ensure a distinguishable timestamp
    const jobId = await runFullScan(db, libraryRootId, dir);
    const job = db.prepare("SELECT files_added, files_updated FROM scan_jobs WHERE id = ?").get(jobId) as {
      files_added: number;
      files_updated: number;
    };
    expect(job.files_added).toBe(0);
    expect(job.files_updated).toBe(0);

    const after = db.prepare("SELECT last_seen_at FROM files").get() as { last_seen_at: string };
    expect(after.last_seen_at >= before.last_seen_at).toBe(true);
  });
});

describe("runIncrementalScan", () => {
  it("only picks up files new to the DB, leaving known files completely untouched", async () => {
    const aPath = path.join(dir, "a.wav");
    writeSilentWav(aPath, 1);
    await runFullScan(db, libraryRootId, dir);
    const before = db.prepare("SELECT last_seen_at, duration_ms FROM files WHERE file_path = ?").get(
      toScannedPath(aPath),
    ) as { last_seen_at: string; duration_ms: number };

    await new Promise((resolve) => setTimeout(resolve, 1100)); // ensure a distinguishable timestamp
    writeSilentWav(aPath, 2); // changed on disk — incremental mode must never notice
    writeSilentWav(path.join(dir, "b.wav"), 1); // genuinely new

    const jobId = await runIncrementalScan(db, libraryRootId, dir);
    const job = db.prepare("SELECT * FROM scan_jobs WHERE id = ?").get(jobId) as {
      status: string;
      mode: string;
      files_scanned: number;
      files_added: number;
      files_updated: number;
      files_missing: number;
    };
    expect(job.status).toBe("done");
    expect(job.mode).toBe("incremental");
    expect(job.files_scanned).toBe(1); // only b.wav — a.wav was never re-stat'd
    expect(job.files_added).toBe(1);
    expect(job.files_updated).toBe(0);
    expect(job.files_missing).toBe(0);

    const after = db.prepare("SELECT last_seen_at, duration_ms FROM files WHERE file_path = ?").get(
      toScannedPath(aPath),
    ) as { last_seen_at: string; duration_ms: number };
    expect(after.last_seen_at).toBe(before.last_seen_at);
    expect(after.duration_ms).toBe(before.duration_ms); // still the original 1s value, not re-parsed

    const totalRows = db.prepare("SELECT COUNT(*) AS n FROM files").get() as { n: number };
    expect(totalRows.n).toBe(2);
  });

  it("does not mark a vanished file missing — that stays full scan's job", async () => {
    const aPath = path.join(dir, "a.wav");
    writeSilentWav(aPath);
    await runFullScan(db, libraryRootId, dir);

    rmSync(aPath);
    writeSilentWav(path.join(dir, "b.wav"));
    const jobId = await runIncrementalScan(db, libraryRootId, dir);
    const job = db.prepare("SELECT files_missing FROM scan_jobs WHERE id = ?").get(jobId) as {
      files_missing: number;
    };
    expect(job.files_missing).toBe(0);

    const file = db.prepare("SELECT missing_since FROM files WHERE file_path = ?").get(
      toScannedPath(aPath),
    ) as { missing_since: string | null };
    expect(file.missing_since).toBeNull();
  });

  it("a no-op incremental scan (nothing new) adds nothing", async () => {
    writeSilentWav(path.join(dir, "a.wav"));
    await runFullScan(db, libraryRootId, dir);

    const jobId = await runIncrementalScan(db, libraryRootId, dir);
    const job = db.prepare("SELECT files_scanned, files_added FROM scan_jobs WHERE id = ?").get(jobId) as {
      files_scanned: number;
      files_added: number;
    };
    expect(job.files_scanned).toBe(0);
    expect(job.files_added).toBe(0);
  });

  it("still recomputes derived data so newly-added files join the graph", async () => {
    writeSilentWav(path.join(dir, "a.wav"));
    await runIncrementalScan(db, libraryRootId, dir);

    const file = db.prepare("SELECT recording_node_id FROM files WHERE file_path = ?").get(
      toScannedPath(path.join(dir, "a.wav")),
    ) as { recording_node_id: number };
    const position = db
      .prepare("SELECT node_id FROM positions WHERE node_id = ? AND granularity = 'tracks'")
      .get(file.recording_node_id);
    expect(position).toBeTruthy();
  });
});
