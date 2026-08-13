import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "../db.js";
import { applyTagWrite } from "./writer.js";
import { isSelfWrite } from "./guard.js";

let db: Database.Database;
let dir: string;
let filePath: string;
let fileId: number;

beforeEach(() => {
  db = openDb(":memory:");
  dir = mkdtempSync(path.join(tmpdir(), "legato-guard-test-"));
  filePath = path.join(dir, "test.flac");
  execFileSync(
    "ffmpeg",
    ["-f", "lavfi", "-i", "sine=frequency=440:duration=0.2", "-metadata", "title=Original", filePath],
    { stdio: "ignore" },
  );

  const node = db.prepare("INSERT INTO nodes (type, title) VALUES ('recording', 'Original') RETURNING id").get() as {
    id: number;
  };
  db.prepare("INSERT INTO recordings (node_id) VALUES (?)").run(node.id);
  const root = db.prepare("INSERT INTO library_roots (path) VALUES (?) RETURNING id").get(dir) as { id: number };
  const file = db
    .prepare(
      "INSERT INTO files (recording_node_id, library_root_id, file_path, file_mtime, file_size) VALUES (?, ?, ?, datetime('now'), 0) RETURNING id",
    )
    .get(node.id, root.id, filePath) as { id: number };
  fileId = file.id;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("isSelfWrite", () => {
  it("is false for a file with no recorded write marker (never written by the app)", async () => {
    expect(await isSelfWrite(db, filePath)).toBe(false);
  });

  it("is true immediately after an app write, once the DB is updated to match", async () => {
    const { writeId, writtenMtime } = await applyTagWrite(filePath, { title: "Fixed" });
    db.prepare("UPDATE files SET app_write_marker = ?, last_written_mtime = ? WHERE id = ?").run(
      writeId,
      writtenMtime,
      fileId,
    );

    expect(await isSelfWrite(db, filePath)).toBe(true);
  });

  it("is false if the file changed again after the recorded write (a real external edit)", async () => {
    const { writeId, writtenMtime } = await applyTagWrite(filePath, { title: "Fixed" });
    db.prepare("UPDATE files SET app_write_marker = ?, last_written_mtime = ? WHERE id = ?").run(
      writeId,
      writtenMtime,
      fileId,
    );

    // Someone/something else edits the file after our write — a real
    // external change, e.g. a fresh ffmpeg-authored file at the same path.
    execFileSync(
      "ffmpeg",
      ["-y", "-f", "lavfi", "-i", "sine=frequency=880:duration=0.2", "-metadata", "title=External Edit", filePath],
      { stdio: "ignore" },
    );

    expect(await isSelfWrite(db, filePath)).toBe(false);
  });

  it("is false for a nonexistent file rather than throwing", async () => {
    expect(await isSelfWrite(db, path.join(dir, "does-not-exist.flac"))).toBe(false);
  });
});
