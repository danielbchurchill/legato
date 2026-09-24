import { describe, expect, it } from "bun:test";
import type { Database } from "../sqlite.js";
import { openDb } from "../db.js";
import { backfillLocalEdges } from "./backfill-edges.js";

function insertFile(db: Database, tags: Record<string, unknown>): { fileId: number; nodeId: number } {
  const node = db.prepare("INSERT INTO nodes (type, title) VALUES ('recording', 'x') RETURNING id").get() as {
    id: number;
  };
  db.prepare("INSERT INTO recordings (node_id) VALUES (?)").run(node.id);
  const root = db.prepare("INSERT INTO library_roots (path) VALUES (?) RETURNING id").get(`/fake/${node.id}`) as {
    id: number;
  };
  const file = db
    .prepare(
      `INSERT INTO files (recording_node_id, library_root_id, file_path, file_mtime, file_size, tags_raw)
       VALUES (?, ?, ?, datetime('now'), 0, ?) RETURNING id`,
    )
    .get(node.id, root.id, `/fake/${node.id}.flac`, JSON.stringify(tags)) as { id: number };
  return { fileId: file.id, nodeId: node.id };
}

describe("backfillLocalEdges", () => {
  it("derives edges from tags_raw already in the DB, no file re-scan needed", () => {
    const db = openDb(":memory:");
    const { nodeId } = insertFile(db, { artist: "The Beatles", label: "Apple Records", producer: ["George Martin"] });

    const count = backfillLocalEdges(db);
    expect(count).toBe(1);

    const types = db
      .prepare("SELECT type FROM edges WHERE from_node = ? ORDER BY type")
      .all(nodeId) as { type: string }[];
    expect(types.map((t) => t.type)).toEqual(["performed_by", "produced_by", "released_on"]);
  });

  it("recovers a real library scenario: a file whose columns were backfilled but whose edges never were", () => {
    const db = openDb(":memory:");
    const { fileId, nodeId } = insertFile(db, { artist: "The Beatles" });

    // Simulate scan/backfill-tags.ts having updated tags_raw with a label
    // that arrived after this file's edges were last derived — exactly
    // what happened on the real library between session 3 and session 4.
    db.prepare("UPDATE files SET tags_raw = ? WHERE id = ?").run(
      JSON.stringify({ artist: "The Beatles", label: "Apple Records" }),
      fileId,
    );

    expect(db.prepare("SELECT COUNT(*) AS n FROM edges WHERE type = 'released_on'").get()).toEqual({ n: 0 });

    backfillLocalEdges(db);

    const labelEdge = db
      .prepare("SELECT COUNT(*) AS n FROM edges WHERE from_node = ? AND type = 'released_on'")
      .get(nodeId) as { n: number };
    expect(labelEdge.n).toBe(1);
  });

  it("skips missing files", () => {
    const db = openDb(":memory:");
    const { fileId } = insertFile(db, { artist: "The Beatles" });
    db.prepare("UPDATE files SET missing_since = datetime('now') WHERE id = ?").run(fileId);

    expect(backfillLocalEdges(db)).toBe(0);
  });
});
