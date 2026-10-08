import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Database } from "./sqlite.js";
import { openDb } from "./db.js";
import { recompute, recomputeOffThread } from "./recompute.js";

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

// Issue #269.
describe("recompute — the membership bound", () => {
  function artist(title: string): number {
    return (
      db.prepare("INSERT INTO nodes (type, title) VALUES ('artist', ?) RETURNING id").get(title) as { id: number }
    ).id;
  }

  function memberOf(member: number, group: number): void {
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'member_of', 'musicbrainz')").run(
      member,
      group,
    );
  }

  function jobsFor(nodeId: number): string[] {
    return (
      db.prepare("SELECT job_type FROM enrich_jobs WHERE node_id = ? ORDER BY job_type").all(nodeId) as {
        job_type: string;
      }[]
    ).map((r) => r.job_type);
  }

  it("queues member lookups for performers and their members and groups, and photos and descriptions one hop further", () => {
    // A producer with an artist node takes the credit (match/edges.ts's
    // findOrCreatePerson), the way #280 merged them.
    const producer = artist("George Martin");
    insertFile({ artist: "The Beatles", producer: ["George Martin"] });
    recompute(db);
    const beatles = (
      db.prepare("SELECT id FROM nodes WHERE type = 'artist' AND title = 'The Beatles'").get() as {
        id: number;
      }
    ).id;
    // What an older, unbounded crawl left: Bob Dylan is a third level.
    const george = artist("George Harrison");
    const wilburys = artist("Traveling Wilburys");
    const dylan = artist("Bob Dylan");
    memberOf(george, beatles);
    memberOf(george, wilburys);
    memberOf(dylan, wilburys);
    db.prepare("DELETE FROM enrich_jobs").run();

    recompute(db);

    const everyLookup = ["artist_image_lookup", "artist_member_lookup", "description_lookup"];
    expect(jobsFor(beatles)).toEqual(everyLookup);
    expect(jobsFor(george)).toEqual(everyLookup);
    // In the library, but a producer doesn't start a crawl.
    expect(jobsFor(producer)).toEqual(["artist_image_lookup", "description_lookup"]);
    expect(jobsFor(wilburys)).toEqual(["artist_image_lookup", "description_lookup"]);
    expect(jobsFor(dylan)).toEqual([]);
  });
});

// Issue #281: what the callers (the scanner, removing a library folder, the
// last artist credit lookup) run. On a file it's a Worker with its own
// connection; these use one so the Worker is what they exercise.
describe("recomputeOffThread", () => {
  let dir: string;
  let fileDb: Database;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "legato-recompute-"));
    fileDb = openDb(path.join(dir, "legato.db"));
    const root = fileDb.prepare("INSERT INTO library_roots (path) VALUES ('/fake') RETURNING id").get() as { id: number };
    for (let i = 0; i < 200; i++) addFile(root.id, i);
  });

  afterEach(() => {
    fileDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function addFile(rootId: number, i: number): number {
    const node = fileDb.prepare("INSERT INTO nodes (type, title) VALUES ('recording', ?) RETURNING id").get(`Track ${i}`) as {
      id: number;
    };
    fileDb.prepare("INSERT INTO recordings (node_id) VALUES (?)").run(node.id);
    fileDb
      .prepare(
        `INSERT INTO files (recording_node_id, library_root_id, file_path, file_mtime, file_size, match_source, tags_raw)
         VALUES (?, ?, ?, datetime('now'), 0, 'mbid', ?)`,
      )
      .run(node.id, rootId, `/fake/${i}.flac`, JSON.stringify({ artist: `Artist ${i % 20}`, album: `Album ${i % 40}` }));
    return node.id;
  }

  const count = (sql: string) => (fileDb.prepare(sql).get() as { n: number }).n;
  // Changes only when another connection commits.
  const dataVersion = () => (fileDb.prepare("PRAGMA data_version").get() as { data_version: number }).data_version;

  it("works on another connection while this thread goes on, and its writes are in once it resolves", async () => {
    const before = dataVersion();
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    await recomputeOffThread(fileDb);
    clearInterval(timer);

    expect(dataVersion()).not.toBe(before);
    expect(ticks).toBeGreaterThan(0);
    expect(count("SELECT COUNT(*) AS n FROM edges WHERE type = 'performed_by'")).toBe(200);
    expect(count("SELECT COUNT(*) AS n FROM albums")).toBe(40);
    expect(count("SELECT COUNT(*) AS n FROM articles")).toBeGreaterThan(0);
  });

  it("runs one at a time, and a call made during a run gets the next one, shared", async () => {
    const first = recomputeOffThread(fileDb);
    const second = recomputeOffThread(fileDb);
    expect(recomputeOffThread(fileDb)).toBe(second);
    expect(second).not.toBe(first);

    let secondDone = false;
    void second.then(() => (secondDone = true));
    const rootId = (fileDb.prepare("SELECT id FROM library_roots").get() as { id: number }).id;
    const late = addFile(rootId, 1000);
    await first;
    expect(secondDone).toBe(false);
    await second;

    expect(count(`SELECT COUNT(*) AS n FROM edges WHERE from_node = ${late} AND type = 'performed_by'`)).toBe(1);
  });

  it("rejects with what went wrong, and the next call starts a new run", async () => {
    fileDb.exec("ALTER TABLE articles RENAME TO articles_away");
    await expect(recomputeOffThread(fileDb)).rejects.toThrow("no such table");
    fileDb.exec("ALTER TABLE articles_away RENAME TO articles");
    await recomputeOffThread(fileDb);
    expect(count("SELECT COUNT(*) AS n FROM articles")).toBeGreaterThan(0);
  });
});
