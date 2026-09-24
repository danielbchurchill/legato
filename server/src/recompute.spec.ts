import { beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "./sqlite.js";
import { openDb } from "./db.js";
import { recompute } from "./recompute.js";

let db: Database;
let libraryRootId: number;

beforeEach(() => {
  db = openDb(":memory:");
  const root = db.prepare("INSERT INTO library_roots (path) VALUES ('/fake') RETURNING id").get() as {
    id: number;
  };
  libraryRootId = root.id;
});

function insertFile(
  tags: Record<string, unknown>,
  overrides: { matchSource?: string } = {},
): { fileId: number; nodeId: number } {
  const node = db.prepare("INSERT INTO nodes (type, title) VALUES ('recording', 'x') RETURNING id").get() as {
    id: number;
  };
  db.prepare("INSERT INTO recordings (node_id) VALUES (?)").run(node.id);
  const file = db
    .prepare(
      `INSERT INTO files (recording_node_id, library_root_id, file_path, file_mtime, file_size, match_source, tags_raw)
       VALUES (?, ?, ?, datetime('now'), 0, ?, ?) RETURNING id`,
    )
    .get(
      node.id,
      libraryRootId,
      `/fake/${node.id}.flac`,
      overrides.matchSource ?? "unmatched",
      JSON.stringify(tags),
    ) as { id: number };
  return { fileId: file.id, nodeId: node.id };
}

describe("recompute — B-1", () => {
  it("derives local edges for a file scanned before this logic existed (bypassing scanFile entirely)", () => {
    const { nodeId } = insertFile({ artist: "The Beatles", releaseDate: "1969-09-26" });

    recompute(db);

    const edges = db
      .prepare("SELECT type FROM edges WHERE from_node = ? ORDER BY type")
      .all(nodeId) as { type: string }[];
    expect(edges.map((e) => e.type)).toEqual(["performed_by", "released_in"]);
  });

  it("enqueues enrichment for a file that has never had a lookup attempted", () => {
    const { nodeId } = insertFile({ artist: "Bob Dylan" });

    recompute(db);

    const jobs = db.prepare("SELECT job_type FROM enrich_jobs WHERE node_id = ?").all(nodeId);
    expect(jobs).toHaveLength(1);
  });

  it("does not re-enqueue a recording whose enrichment already ran to completion", () => {
    const { nodeId } = insertFile({ artist: "Bob Dylan" });
    db.prepare("INSERT INTO enrich_jobs (node_id, job_type, status) VALUES (?, 'recording_lookup', 'done')").run(
      nodeId,
    );

    recompute(db);

    const jobs = db.prepare("SELECT id FROM enrich_jobs WHERE node_id = ?").all(nodeId);
    expect(jobs).toHaveLength(1); // still just the one 'done' row — no duplicate queued
  });

  it("does not enqueue enrichment for an already-matched recording", () => {
    const { nodeId } = insertFile({ artist: "The Beatles" }, { matchSource: "mbid" });

    recompute(db);

    const jobs = db.prepare("SELECT id FROM enrich_jobs WHERE node_id = ?").all(nodeId);
    expect(jobs).toHaveLength(0);
  });

  it("skips missing files entirely — no edges, no enrichment", () => {
    const { fileId, nodeId } = insertFile({ artist: "The Beatles" });
    db.prepare("UPDATE files SET missing_since = datetime('now') WHERE id = ?").run(fileId);

    recompute(db);

    expect(db.prepare("SELECT COUNT(*) AS n FROM edges WHERE from_node = ?").get(nodeId)).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM enrich_jobs WHERE node_id = ?").get(nodeId)).toEqual({ n: 0 });
  });

  it("is idempotent — a second call doesn't duplicate edges or jobs", () => {
    const { nodeId } = insertFile({ artist: "The Beatles", releaseDate: "1969" });

    recompute(db);
    recompute(db);

    const edgeCount = db.prepare("SELECT COUNT(*) AS n FROM edges WHERE from_node = ?").get(nodeId) as {
      n: number;
    };
    expect(edgeCount.n).toBe(2); // performed_by, released_in — not 4

    const jobCount = db.prepare("SELECT COUNT(*) AS n FROM enrich_jobs WHERE node_id = ?").get(nodeId) as {
      n: number;
    };
    expect(jobCount.n).toBe(1);
  });
});
