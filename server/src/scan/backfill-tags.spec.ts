import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "../db.js";
import { backfillTagColumns } from "./backfill-tags.js";

let db: Database.Database;
let dir: string;

beforeEach(() => {
  db = openDb(":memory:");
  dir = mkdtempSync(path.join(tmpdir(), "legato-tag-backfill-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function insertFile(filePath: string, extraColumns: Record<string, unknown> = {}): number {
  const root = db.prepare("INSERT INTO library_roots (path) VALUES (?) RETURNING id").get(dir) as { id: number };
  const node = db.prepare("INSERT INTO nodes (type, title) VALUES ('recording', 'x') RETURNING id").get() as {
    id: number;
  };
  db.prepare("INSERT INTO recordings (node_id) VALUES (?)").run(node.id);

  const columns = ["recording_node_id", "library_root_id", "file_path", "file_mtime", "file_size", ...Object.keys(extraColumns)];
  const values = [node.id, root.id, filePath, "2026-01-01T00:00:00.000Z", 0, ...Object.values(extraColumns)];
  const placeholders = columns.map(() => "?").join(", ");
  const row = db
    .prepare(`INSERT INTO files (${columns.join(", ")}) VALUES (${placeholders}) RETURNING id`)
    .get(...values) as { id: number };
  return row.id;
}

describe("backfillTagColumns", () => {
  it("parses release_date/bpm/label/release_type/genre for a file left over from before those columns existed", async () => {
    const filePath = path.join(dir, "track.flac");
    execFileSync(
      "ffmpeg",
      [
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=0.2",
        "-metadata",
        "date=1969-09-26",
        "-metadata",
        "bpm=82",
        "-metadata",
        "label=Apple Records",
        "-metadata",
        "releasetype=album",
        "-metadata",
        "genre=Rock",
        filePath,
      ],
      { stdio: "ignore" },
    );
    const fileId = insertFile(filePath);

    const progress = await backfillTagColumns(db);
    expect(progress).toEqual({ filesConsidered: 1, filesUpdated: 1, failures: 0 });

    const row = db
      .prepare("SELECT release_date, bpm, label, release_type, genre FROM files WHERE id = ?")
      .get(fileId) as {
      release_date: string;
      bpm: number;
      label: string;
      release_type: string;
      genre: string;
    };
    expect(row.release_date).toBe("1969-09-26");
    expect(row.bpm).toBe(82);
    expect(row.label).toBe("Apple Records");
    expect(row.release_type).toBe("album");
    expect(JSON.parse(row.genre)).toEqual(["Rock"]);
  });

  it("skips a file that already has these columns populated, without opening it", async () => {
    // A nonexistent path would make parseTags() throw if this file were
    // ever opened — proof the skip check works, not just that the count matches.
    const fileId = insertFile(path.join(dir, "does-not-exist.flac"), { release_date: "2000" });

    const progress = await backfillTagColumns(db);
    expect(progress).toEqual({ filesConsidered: 0, filesUpdated: 0, failures: 0 });

    const row = db.prepare("SELECT release_date FROM files WHERE id = ?").get(fileId) as { release_date: string };
    expect(row.release_date).toBe("2000");
  });

  it("records a failure without throwing when a file can't be parsed", async () => {
    insertFile(path.join(dir, "does-not-exist.flac"));

    const progress = await backfillTagColumns(db);
    expect(progress).toEqual({ filesConsidered: 1, filesUpdated: 0, failures: 1 });
  });
});
