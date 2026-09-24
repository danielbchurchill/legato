import { beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "../sqlite.js";
import { openDb } from "../db.js";
import { collapseFile } from "./collapse.js";

let db: Database;
let libraryRootId: number;

beforeEach(() => {
  db = openDb(":memory:");
  const row = db
    .prepare("INSERT INTO library_roots (path) VALUES ('/fake') RETURNING id")
    .get() as { id: number };
  libraryRootId = row.id;
});

// Mirrors what scanner.ts's insert branch does, without needing a real
// audio file on disk — collapseFile() only reads from the DB, so this is
// enough to exercise it directly (same "pure core, thin I/O shell" split
// as tags.spec.ts).
function insertProvisionalFile(
  filePath: string,
  tags: { title?: string; artist?: string; durationMs?: number; mbRecordingId?: string },
): number {
  const title = tags.title ?? filePath;
  const node = db
    .prepare("INSERT INTO nodes (type, title) VALUES ('recording', ?) RETURNING id")
    .get(title) as { id: number };
  db.prepare("INSERT INTO recordings (node_id, canonical_duration_ms) VALUES (?, ?)").run(
    node.id,
    tags.durationMs ?? null,
  );
  const file = db
    .prepare(
      `INSERT INTO files (recording_node_id, library_root_id, file_path, file_mtime, file_size, tags_raw)
       VALUES (?, ?, ?, datetime('now'), 0, ?) RETURNING id`,
    )
    .get(node.id, libraryRootId, filePath, JSON.stringify(tags)) as { id: number };
  return file.id;
}

function fileState(fileId: number) {
  return db
    .prepare(
      "SELECT recording_node_id, match_source, match_confidence, fuzzy_candidate_node_id FROM files WHERE id = ?",
    )
    .get(fileId) as {
    recording_node_id: number;
    match_source: string;
    match_confidence: number | null;
    fuzzy_candidate_node_id: number | null;
  };
}

describe("collapseFile — tier 1 (mbid)", () => {
  it("makes the first file's node canonical for a fresh mbid", async () => {
    const fileId = insertProvisionalFile("/fake/a.flac", { mbRecordingId: "mb-1" });
    await collapseFile(db, fileId);

    const state = fileState(fileId);
    expect(state.match_source).toBe("mbid");
    expect(state.match_confidence).toBe(1.0);

    const node = db.prepare("SELECT mbid FROM nodes WHERE id = ?").get(state.recording_node_id) as {
      mbid: string;
    };
    expect(node.mbid).toBe("mb-1");
  });

  it("collapses a second file with the same mbid onto the first file's node", async () => {
    const fileA = insertProvisionalFile("/fake/a.flac", { mbRecordingId: "mb-1" });
    await collapseFile(db, fileA);
    const nodeA = fileState(fileA).recording_node_id;

    const fileB = insertProvisionalFile("/fake/b-remaster.flac", { mbRecordingId: "mb-1" });
    await collapseFile(db, fileB);
    const stateB = fileState(fileB);

    expect(stateB.match_source).toBe("mbid");
    expect(stateB.recording_node_id).toBe(nodeA);

    // Both files now resolve to the same node — the point of collapse.
    const distinctNodes = db
      .prepare("SELECT COUNT(DISTINCT recording_node_id) AS n FROM files WHERE id IN (?, ?)")
      .get(fileA, fileB) as { n: number };
    expect(distinctNodes.n).toBe(1);
  });

  it("does not merge files with different mbids", async () => {
    const fileA = insertProvisionalFile("/fake/a.flac", { mbRecordingId: "mb-1" });
    const fileB = insertProvisionalFile("/fake/b.flac", { mbRecordingId: "mb-2" });
    await collapseFile(db, fileA);
    await collapseFile(db, fileB);

    expect(fileState(fileA).recording_node_id).not.toBe(fileState(fileB).recording_node_id);
  });
});

describe("collapseFile — tier 3 (fuzzy)", () => {
  it("flags a plausible match for confirmation without merging it", async () => {
    const fileA = insertProvisionalFile("/fake/a.flac", {
      title: "Come Together",
      artist: "The Beatles",
      durationMs: 262000,
    });
    await collapseFile(db, fileA);
    const nodeA = fileState(fileA).recording_node_id;

    const fileB = insertProvisionalFile("/fake/b.flac", {
      title: "come  together", // different case/spacing — should still normalize-match
      artist: "The Beatles",
      durationMs: 262800, // within 2s tolerance
    });
    await collapseFile(db, fileB);
    const stateB = fileState(fileB);

    expect(stateB.match_source).toBe("fuzzy_pending");
    expect(stateB.fuzzy_candidate_node_id).toBe(nodeA);
    // Not actually merged — false merges hide music, so this stays split
    // until a human confirms it.
    expect(stateB.recording_node_id).not.toBe(nodeA);
  });

  it("does not flag a candidate outside the duration tolerance", async () => {
    const fileA = insertProvisionalFile("/fake/a.flac", {
      title: "Come Together",
      artist: "The Beatles",
      durationMs: 262000,
    });
    await collapseFile(db, fileA);

    const fileB = insertProvisionalFile("/fake/b.flac", {
      title: "Come Together",
      artist: "The Beatles",
      durationMs: 300000, // 38s off — a different edit/live version, not the same recording
    });
    await collapseFile(db, fileB);

    expect(fileState(fileB).match_source).toBe("unmatched");
  });

  it("does not flag a candidate with a different artist", async () => {
    const fileA = insertProvisionalFile("/fake/a.flac", {
      title: "Yesterday",
      artist: "The Beatles",
      durationMs: 125000,
    });
    await collapseFile(db, fileA);

    const fileB = insertProvisionalFile("/fake/b.flac", {
      title: "Yesterday",
      artist: "Some Cover Band",
      durationMs: 125000,
    });
    await collapseFile(db, fileB);

    expect(fileState(fileB).match_source).toBe("unmatched");
  });
});

describe("collapseFile — merge_overrides precedence", () => {
  it("a forced merge wins over tier evidence and is re-applied on every re-scan", async () => {
    const fileA = insertProvisionalFile("/fake/a.flac", { mbRecordingId: "mb-1" });
    const fileB = insertProvisionalFile("/fake/b.flac", { mbRecordingId: "mb-2" }); // would NOT tier-1 match A
    await collapseFile(db, fileA);
    await collapseFile(db, fileB);
    const nodeA = fileState(fileA).recording_node_id;
    expect(fileState(fileB).recording_node_id).not.toBe(nodeA);

    db.prepare(
      "INSERT INTO merge_overrides (file_id, forced_recording_node_id, decided_by) VALUES (?, ?, 'user')",
    ).run(fileB, nodeA);

    await collapseFile(db, fileB);
    expect(fileState(fileB).match_source).toBe("manual");
    expect(fileState(fileB).recording_node_id).toBe(nodeA);

    // Re-scan (re-running collapse) doesn't undo it — tiers never
    // re-evaluate once a user decision exists.
    await collapseFile(db, fileB);
    expect(fileState(fileB).recording_node_id).toBe(nodeA);
  });

  it("a forced split (null target) gives the file back a standalone node, idempotently", async () => {
    const fileA = insertProvisionalFile("/fake/a.flac", { mbRecordingId: "mb-1" });
    const fileB = insertProvisionalFile("/fake/b.flac", { mbRecordingId: "mb-1" }); // tier-1 would merge these
    await collapseFile(db, fileA);
    await collapseFile(db, fileB);
    expect(fileState(fileA).recording_node_id).toBe(fileState(fileB).recording_node_id);

    db.prepare(
      "INSERT INTO merge_overrides (file_id, forced_recording_node_id, decided_by) VALUES (?, NULL, 'user')",
    ).run(fileB);
    await collapseFile(db, fileB);

    const splitNodeId = fileState(fileB).recording_node_id;
    expect(splitNodeId).not.toBe(fileState(fileA).recording_node_id);
    expect(fileState(fileB).match_source).toBe("manual");

    // Re-running the split again shouldn't fork off yet another node.
    await collapseFile(db, fileB);
    expect(fileState(fileB).recording_node_id).toBe(splitNodeId);
  });
});
