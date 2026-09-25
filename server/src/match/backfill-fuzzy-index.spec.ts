import { describe, expect, it } from "bun:test";
import type { Database } from "../sqlite.js";
import { openDb } from "../db.js";
import { backfillFuzzyIndex } from "./backfill-fuzzy-index.js";

function insertFile(
  db: Database,
  tags: Record<string, unknown>,
  matchSource: string = "unmatched",
): { fileId: number; nodeId: number } {
  const node = db.prepare("INSERT INTO nodes (type, title) VALUES ('recording', 'x') RETURNING id").get() as {
    id: number;
  };
  db.prepare("INSERT INTO recordings (node_id) VALUES (?)").run(node.id);
  const root = db.prepare("INSERT INTO library_roots (path) VALUES (?) RETURNING id").get(`/fake/${node.id}`) as {
    id: number;
  };
  const file = db
    .prepare(
      `INSERT INTO files (recording_node_id, library_root_id, file_path, file_mtime, file_size, tags_raw, match_source)
       VALUES (?, ?, ?, datetime('now'), 0, ?, ?) RETURNING id`,
    )
    .get(node.id, root.id, `/fake/${node.id}.flac`, JSON.stringify(tags), matchSource) as { id: number };
  return { fileId: file.id, nodeId: node.id };
}

function normalizedCols(db: Database, fileId: number): { normalized_title: string | null; normalized_artist: string | null } {
  return db
    .prepare("SELECT normalized_title, normalized_artist FROM files WHERE id = ?")
    .get(fileId) as { normalized_title: string | null; normalized_artist: string | null };
}

describe("backfillFuzzyIndex", () => {
  it("populates normalized_title/normalized_artist from tags_raw already in the DB, no rescan needed", () => {
    const db = openDb(":memory:");
    const { fileId } = insertFile(db, { title: "Come  Together", artist: "The Beatles" });

    const count = backfillFuzzyIndex(db);
    expect(count).toBe(1);
    expect(normalizedCols(db, fileId)).toEqual({
      normalized_title: "come together",
      normalized_artist: "the beatles",
    });
  });

  it("skips files already matched (mbid/acoustid/manual) — never eligible fuzzy candidates", () => {
    const db = openDb(":memory:");
    const { fileId } = insertFile(db, { title: "Yesterday", artist: "The Beatles" }, "mbid");

    expect(backfillFuzzyIndex(db)).toBe(0);
    expect(normalizedCols(db, fileId)).toEqual({ normalized_title: null, normalized_artist: null });
  });

  it("skips files with no title or artist tag — never matchable, same as tryFuzzyMatch's own guard", () => {
    const db = openDb(":memory:");
    insertFile(db, { title: "Yesterday" }); // no artist
    insertFile(db, {}); // neither

    expect(backfillFuzzyIndex(db)).toBe(0);
  });

  it("does not overwrite columns tryFuzzyMatch has already populated", () => {
    const db = openDb(":memory:");
    const { fileId } = insertFile(db, { title: "Yesterday", artist: "The Beatles" }, "fuzzy_pending");
    db.prepare("UPDATE files SET normalized_title = 'already set', normalized_artist = 'already set' WHERE id = ?").run(
      fileId,
    );

    expect(backfillFuzzyIndex(db)).toBe(0);
    expect(normalizedCols(db, fileId)).toEqual({ normalized_title: "already set", normalized_artist: "already set" });
  });
});
