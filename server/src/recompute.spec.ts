import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Database } from "./sqlite.js";
import { openDb } from "./db.js";
import { recompute, recomputeOffThread } from "./recompute.js";
import { libraryRevision } from "./libraryRevision.js";
import { registerSocket } from "./ws.js";

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
// Issue #354.
describe("recompute — planner statistics", () => {
  it("ends with statistics for the rows it wrote", () => {
    for (let i = 0; i < 20; i++) insertFile({ artist: `Artist ${i}`, album: `Album ${i % 4}` });

    recompute(db);

    const { n: edges } = db.prepare("SELECT COUNT(*) AS n FROM edges").get() as { n: number };
    const { stat } = db.prepare("SELECT stat FROM sqlite_stat1 WHERE idx = 'edges_from_node_idx'").get() as { stat: string };
    expect(edges).toBeGreaterThan(0);
    expect(stat.split(" ")[0]).toBe(String(edges));
  });
});

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

  it("ends each run, finished or failed, with one library:changed and a higher revision, once its writes are in", async () => {
    const sent: { event: string; revision: number; albums: number }[] = [];
    let close = () => {};
    registerSocket({
      readyState: 1,
      OPEN: 1,
      send: (message: string) => {
        const { event, payload } = JSON.parse(message);
        sent.push({ event, revision: payload.revision, albums: count("SELECT COUNT(*) AS n FROM albums") });
      },
      on: (_event: string, onClose: () => void) => (close = onClose),
    } as unknown as Parameters<typeof registerSocket>[0]);
    try {
      const before = libraryRevision();
      const first = recomputeOffThread(fileDb);
      const second = recomputeOffThread(fileDb);
      await first;
      await second;
      fileDb.exec("ALTER TABLE articles RENAME TO articles_away");
      await recomputeOffThread(fileDb).catch(() => undefined);
      fileDb.exec("ALTER TABLE articles_away RENAME TO articles");

      expect(sent).toEqual([
        { event: "library:changed", revision: before + 1, albums: 40 },
        { event: "library:changed", revision: before + 2, albums: 40 },
        { event: "library:changed", revision: before + 3, albums: 40 },
      ]);
      expect(libraryRevision()).toBe(before + 3);
    } finally {
      close();
    }
  });

  it("rejects with what went wrong, and the next call starts a new run", async () => {
    fileDb.exec("ALTER TABLE articles RENAME TO articles_away");
    await expect(recomputeOffThread(fileDb)).rejects.toThrow("no such table");
    fileDb.exec("ALTER TABLE articles_away RENAME TO articles");
    await recomputeOffThread(fileDb);
    expect(count("SELECT COUNT(*) AS n FROM articles")).toBeGreaterThan(0);
  });

  // Issue #354: statistics the worker gathers reach this connection only if
  // it reads them again, since ANALYZE leaves the schema as it was. Two plays
  // and the run's edges: SQLite, planning without statistics, starts from
  // edges; with them, from the two plays.
  it("leaves this connection planning with the statistics the run gathered", async () => {
    const file = fileDb.prepare("SELECT id, recording_node_id AS recording FROM files LIMIT 1").get() as {
      id: number;
      recording: number;
    };
    const play = fileDb.prepare(
      "INSERT INTO plays (recording_node_id, file_id, started_at, ms_played) VALUES (?, ?, datetime('now'), 200000)",
    );
    play.run(file.recording, file.id);
    play.run(file.recording, file.id);
    const firstLoop = () =>
      (
        fileDb
          .prepare(
            `EXPLAIN QUERY PLAN SELECT e.to_node, COUNT(*) FROM plays p
             JOIN edges e ON e.from_node = p.recording_node_id AND e.type = 'appears_on'
             GROUP BY e.to_node`,
          )
          .all() as { detail: string }[]
      )[0].detail;
    expect(firstLoop()).toStartWith("SCAN e ");

    await recomputeOffThread(fileDb);

    expect(firstLoop()).toStartWith("SCAN p ");
  });
});
