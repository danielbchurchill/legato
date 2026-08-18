import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "./db.js";
import { countLibraryRootContents, removeLibraryRootCascade } from "./library-roots.js";

let db: Database.Database;

beforeEach(() => {
  db = openDb(":memory:");
});

// A root with one file that has accumulated everything a file can:
// a play, a tag write, a merge override, and cached cover art.
function seedRoot(path: string): { rootId: number; fileId: number; nodeId: number } {
  const rootId = (
    db.prepare("INSERT INTO library_roots (path) VALUES (?) RETURNING id").get(path) as { id: number }
  ).id;
  const nodeId = (
    db.prepare("INSERT INTO nodes (type, title) VALUES ('recording', 'Visions of Johanna') RETURNING id").get() as {
      id: number;
    }
  ).id;
  db.prepare("INSERT INTO recordings (node_id) VALUES (?)").run(nodeId);
  const fileId = (
    db
      .prepare(
        `INSERT INTO files (recording_node_id, library_root_id, file_path, file_mtime, file_size)
         VALUES (?, ?, ?, datetime('now'), 0) RETURNING id`,
      )
      .get(nodeId, rootId, `${path}/track.flac`) as { id: number }
  ).id;
  db.prepare("INSERT INTO scan_jobs (library_root_id, status) VALUES (?, 'done')").run(rootId);
  db.prepare(
    "INSERT INTO plays (recording_node_id, file_id, started_at, ms_played) VALUES (?, ?, datetime('now'), 1000)",
  ).run(nodeId, fileId);
  db.prepare("INSERT INTO tag_writes (file_id, diff_json) VALUES (?, '{}')").run(fileId);
  db.prepare("INSERT INTO merge_overrides (file_id, decided_by) VALUES (?, 'user')").run(fileId);
  return { rootId, fileId, nodeId };
}

describe("countLibraryRootContents", () => {
  it("reports what removal would destroy", () => {
    const { rootId } = seedRoot("/mnt/music");
    expect(countLibraryRootContents(db, rootId)).toEqual({ files: 1, plays: 1, tagWrites: 1 });
  });

  it("reports zeroes for a root that owns nothing", () => {
    const rootId = (
      db.prepare("INSERT INTO library_roots (path) VALUES ('/empty') RETURNING id").get() as { id: number }
    ).id;
    expect(countLibraryRootContents(db, rootId)).toEqual({ files: 0, plays: 0, tagWrites: 0 });
  });
});

describe("removeLibraryRootCascade", () => {
  // The original bug: adding a root scans it immediately, so every root has a
  // scan job, and a bare DELETE always failed the foreign key.
  it("removes a root that has been scanned", () => {
    const rootId = (
      db.prepare("INSERT INTO library_roots (path) VALUES ('/empty') RETURNING id").get() as { id: number }
    ).id;
    db.prepare("INSERT INTO scan_jobs (library_root_id, status) VALUES (?, 'done')").run(rootId);

    expect(() => removeLibraryRootCascade(db, rootId)).not.toThrow();
    expect(db.prepare("SELECT id FROM library_roots WHERE id = ?").get(rootId)).toBeUndefined();
    expect(db.prepare("SELECT id FROM scan_jobs WHERE library_root_id = ?").all(rootId)).toEqual([]);
  });

  it("removes files and everything referencing them", () => {
    const { rootId, fileId } = seedRoot("/mnt/music");

    removeLibraryRootCascade(db, rootId);

    expect(db.prepare("SELECT id FROM library_roots WHERE id = ?").get(rootId)).toBeUndefined();
    expect(db.prepare("SELECT id FROM files WHERE id = ?").get(fileId)).toBeUndefined();
    expect(db.prepare("SELECT id FROM plays WHERE file_id = ?").all(fileId)).toEqual([]);
    expect(db.prepare("SELECT id FROM merge_overrides WHERE file_id = ?").all(fileId)).toEqual([]);
    expect(db.prepare("SELECT id FROM tag_writes WHERE file_id = ?").all(fileId)).toEqual([]);
  });

  it("leaves another root's files completely untouched", () => {
    const doomed = seedRoot("/mnt/music");
    const keeper = seedRoot("/mnt/other");

    removeLibraryRootCascade(db, doomed.rootId);

    expect(db.prepare("SELECT id FROM files WHERE id = ?").get(keeper.fileId)).toBeTruthy();
    expect(db.prepare("SELECT id FROM plays WHERE file_id = ?").all(keeper.fileId)).toHaveLength(1);
    expect(db.prepare("SELECT id FROM library_roots WHERE id = ?").get(keeper.rootId)).toBeTruthy();
  });
});
