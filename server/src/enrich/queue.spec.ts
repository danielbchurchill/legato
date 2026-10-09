import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "../sqlite.js";
import { openDb } from "../db.js";
import {
  enqueueArtistImageLookupIfNeeded,
  enqueueCoverArtLookupIfNeeded,
  enqueueDescriptionLookupIfNeeded,
  enqueueEnrichmentIfNeeded,
  enqueueLookupsInBound,
  isEnrichmentEnabled,
  withBound,
  BOUND_SQL,
} from "./queue.js";

let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
});

function insertNode(matchSource: string): number {
  const node = db.prepare("INSERT INTO nodes (type, title) VALUES ('recording', 'x') RETURNING id").get() as {
    id: number;
  };
  db.prepare("INSERT INTO recordings (node_id) VALUES (?)").run(node.id);
  const root = db.prepare("INSERT INTO library_roots (path) VALUES ('/fake') RETURNING id").get() as { id: number };
  db.prepare(
    `INSERT INTO files (recording_node_id, library_root_id, file_path, file_mtime, file_size, match_source)
     VALUES (?, ?, '/fake/x.flac', datetime('now'), 0, ?)`,
  ).run(node.id, root.id, matchSource);
  return node.id;
}

describe("isEnrichmentEnabled", () => {
  it("defaults to enabled when the setting was never written", () => {
    expect(isEnrichmentEnabled(db)).toBe(true);
  });

  it("respects an explicit 'false'", () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('enrichmentEnabled', 'false')").run();
    expect(isEnrichmentEnabled(db)).toBe(false);
  });

  it("treats anything other than the literal 'false' as enabled", () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('enrichmentEnabled', 'true')").run();
    expect(isEnrichmentEnabled(db)).toBe(true);
  });
});

describe("enqueueEnrichmentIfNeeded", () => {
  it("queues a job for a node without a confident mbid", () => {
    const nodeId = insertNode("unmatched");
    enqueueEnrichmentIfNeeded(db, nodeId);
    const job = db.prepare("SELECT status FROM enrich_jobs WHERE node_id = ?").get(nodeId) as { status: string };
    expect(job.status).toBe("queued");
  });

  it("does not queue a node that already has a confident local mbid", () => {
    const nodeId = insertNode("mbid");
    enqueueEnrichmentIfNeeded(db, nodeId);
    expect(db.prepare("SELECT COUNT(*) AS n FROM enrich_jobs WHERE node_id = ?").get(nodeId)).toEqual({ n: 0 });
  });

  it("does not double-queue a node that already has a pending job", () => {
    const nodeId = insertNode("unmatched");
    enqueueEnrichmentIfNeeded(db, nodeId);
    enqueueEnrichmentIfNeeded(db, nodeId);
    expect(db.prepare("SELECT COUNT(*) AS n FROM enrich_jobs WHERE node_id = ?").get(nodeId)).toEqual({ n: 1 });
  });

  it("does not queue anything when the global setting is disabled", () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('enrichmentEnabled', 'false')").run();
    const nodeId = insertNode("unmatched");
    enqueueEnrichmentIfNeeded(db, nodeId);
    expect(db.prepare("SELECT COUNT(*) AS n FROM enrich_jobs WHERE node_id = ?").get(nodeId)).toEqual({ n: 0 });
  });
});

describe("enqueueCoverArtLookupIfNeeded", () => {
  function insertReleaseNode(): number {
    const node = db.prepare("INSERT INTO nodes (type, title) VALUES ('release', 'Abbey Road') RETURNING id").get() as {
      id: number;
    };
    return node.id;
  }

  it("queues a cover_art_lookup job for a release node", () => {
    const releaseNodeId = insertReleaseNode();
    enqueueCoverArtLookupIfNeeded(db, releaseNodeId);
    const job = db.prepare("SELECT job_type, status FROM enrich_jobs WHERE node_id = ?").get(releaseNodeId) as {
      job_type: string;
      status: string;
    };
    expect(job.job_type).toBe("cover_art_lookup");
    expect(job.status).toBe("queued");
  });

  it("does not double-queue a release that already has a pending job", () => {
    const releaseNodeId = insertReleaseNode();
    enqueueCoverArtLookupIfNeeded(db, releaseNodeId);
    enqueueCoverArtLookupIfNeeded(db, releaseNodeId);
    expect(db.prepare("SELECT COUNT(*) AS n FROM enrich_jobs WHERE node_id = ?").get(releaseNodeId)).toEqual({
      n: 1,
    });
  });
});

describe("artist image and description lookups", () => {
  function insertArtistNode(title = "Genesis Owusu"): number {
    return (
      db.prepare("INSERT INTO nodes (type, title) VALUES ('artist', ?) RETURNING id").get(title) as { id: number }
    ).id;
  }

  function jobTypes(nodeId: number): string[] {
    return (
      db.prepare("SELECT job_type FROM enrich_jobs WHERE node_id = ? ORDER BY id").all(nodeId) as {
        job_type: string;
      }[]
    ).map((row) => row.job_type);
  }

  it("queues both kinds for one artist node without colliding", () => {
    const nodeId = insertArtistNode();
    enqueueArtistImageLookupIfNeeded(db, nodeId);
    enqueueDescriptionLookupIfNeeded(db, nodeId);
    expect(jobTypes(nodeId)).toEqual(["artist_image_lookup", "description_lookup"]);
  });

  // These run from recompute() on every scan, so "already tried" — not "in
  // flight" — has to be what stops a second one, or every no-op re-scan spends
  // a rate-limited request per artist re-learning the same answer.
  it("never re-queues a lookup that already finished", () => {
    const nodeId = insertArtistNode();
    enqueueArtistImageLookupIfNeeded(db, nodeId);
    db.prepare("UPDATE enrich_jobs SET status = 'done' WHERE node_id = ?").run(nodeId);

    enqueueArtistImageLookupIfNeeded(db, nodeId);
    expect(jobTypes(nodeId)).toEqual(["artist_image_lookup"]);
  });

  it("respects the global enrichment switch", () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('enrichmentEnabled', 'false')").run();
    const nodeId = insertArtistNode();
    enqueueArtistImageLookupIfNeeded(db, nodeId);
    enqueueDescriptionLookupIfNeeded(db, nodeId);
    expect(jobTypes(nodeId)).toEqual([]);
  });
});

// Issue #281: recompute's three statements, one per job type, in place of
// three enqueueOnce calls per node.
describe("enqueueLookupsInBound", () => {
  let performer: number;
  let release: number;

  beforeEach(() => {
    const node = (type: string, title: string) =>
      (db.prepare("INSERT INTO nodes (type, title) VALUES (?, ?) RETURNING id").get(type, title) as { id: number }).id;
    const recording = node("recording", "Something");
    performer = node("artist", "The Beatles");
    release = node("release", "Abbey Road");
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'performed_by', 'local')").run(
      recording,
      performer,
    );
  });

  const jobs = () =>
    db.prepare("SELECT node_id AS nodeId, job_type AS jobType, status FROM enrich_jobs ORDER BY id").all() as {
      nodeId: number;
      jobType: string;
      status: string;
    }[];

  it("queues each lookup once for each node it's for", () => {
    enqueueLookupsInBound(db);
    expect(jobs()).toEqual([
      { nodeId: performer, jobType: "artist_image_lookup", status: "queued" },
      { nodeId: performer, jobType: "artist_member_lookup", status: "queued" },
      { nodeId: performer, jobType: "description_lookup", status: "queued" },
      { nodeId: release, jobType: "description_lookup", status: "queued" },
    ]);

    enqueueLookupsInBound(db);
    expect(jobs()).toHaveLength(4);
  });

  it("queues nothing more for a node that has a job of that type in any status", () => {
    const statuses = ["queued", "running", "done", "error", "deferred"];
    for (const status of statuses) {
      db.prepare("DELETE FROM enrich_jobs").run();
      for (const [nodeId, jobType] of [
        [performer, "artist_image_lookup"],
        [performer, "artist_member_lookup"],
        [performer, "description_lookup"],
        [release, "description_lookup"],
      ] as const) {
        db.prepare("INSERT INTO enrich_jobs (node_id, job_type, status) VALUES (?, ?, ?)").run(nodeId, jobType, status);
      }
      enqueueLookupsInBound(db);
      expect(jobs().map((job) => job.status)).toEqual([status, status, status, status]);
    }
  });

  it("respects the global enrichment switch", () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('enrichmentEnabled', 'false')").run();
    enqueueLookupsInBound(db);
    expect(jobs()).toEqual([]);
  });
});

// Issue #321.
describe("withBound", () => {
  const node = (on: Database, type: string, title: string) =>
    (on.prepare("INSERT INTO nodes (type, title) VALUES (?, ?) RETURNING id").get(type, title) as { id: number }).id;
  const edge = (on: Database, from: number, to: number, type: string) =>
    on.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, ?, 'local')").run(from, to, type);
  const ids = (table: string, on: Database = db) =>
    (on.prepare(`SELECT id FROM temp.${table} ORDER BY id`).all() as { id: number }[]).map((r) => r.id);
  const tempTables = () =>
    (db.prepare("SELECT name FROM sqlite_temp_master WHERE type = 'table'").all() as { name: string }[]).map(
      (r) => r.name,
    );

  // A band in the library, its member, and the member's other group.
  function library(on: Database) {
    const beatles = node(on, "artist", "The Beatles");
    const george = node(on, "artist", "George Harrison");
    const wilburys = node(on, "artist", "Traveling Wilburys");
    edge(on, node(on, "recording", "Something"), beatles, "performed_by");
    edge(on, george, beatles, "member_of");
    edge(on, george, wilburys, "member_of");
    return { beatles, george, wilburys };
  }

  it("reads the performers, their members and groups, and the groups of those, then drops its tables", () => {
    const { beatles, george, wilburys } = library(db);

    const sets = withBound(db, () => ({ lookup: ids("member_lookup_artists"), inBound: ids("artists_in_bound") }));

    expect(sets).toEqual({ lookup: [beatles, george], inBound: [beatles, george, wilburys] });
    expect(tempTables()).toEqual([]);
  });

  it("reads all three sets from one snapshot, whatever another connection commits in between", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "legato-bound-"));
    const file = path.join(dir, "legato.db");
    const reader = openDb(file, { log: () => {} });
    const writer = openDb(file, { log: () => {} });
    try {
      const { beatles, george, wilburys } = library(reader);
      // After the performers are read, a new band and a new member of the
      // old one are committed on the other connection.
      const exec = reader.exec.bind(reader);
      Object.assign(reader, {
        exec: (sql: string) => {
          exec(sql);
          if (sql === BOUND_SQL[0]) {
            edge(writer, node(writer, "recording", "Creep"), node(writer, "artist", "Radiohead"), "performed_by");
            edge(writer, node(writer, "artist", "Pete Best"), beatles, "member_of");
          }
        },
      });

      const sets = withBound(reader, () => ({
        performers: ids("performers", reader),
        lookup: ids("member_lookup_artists", reader),
        inBound: ids("artists_in_bound", reader),
      }));

      expect(sets).toEqual({ performers: [beatles], lookup: [beatles, george], inBound: [beatles, george, wilburys] });
      Object.assign(reader, { exec });
      expect(withBound(reader, () => ids("artists_in_bound", reader))).toHaveLength(5);
    } finally {
      writer.close();
      reader.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws at a nested call before touching the caller's tables", () => {
    const { beatles, george, wilburys } = library(db);

    withBound(db, () => {
      expect(() => withBound(db, () => 0)).toThrow(
        "withBound: already reading the bound on this connection; read its temp tables instead of nesting",
      );
      expect(ids("artists_in_bound")).toEqual([beatles, george, wilburys]);
    });

    expect(tempTables()).toEqual([]);
    expect(withBound(db, () => ids("member_lookup_artists"))).toEqual([beatles, george]);
  });

  describe("when a table won't drop", () => {
    let failDrop: boolean;

    beforeEach(() => {
      failDrop = false;
      const exec = db.exec.bind(db);
      Object.assign(db, {
        exec: (sql: string) => {
          if (failDrop && sql === "DROP TABLE IF EXISTS temp.performers") throw new Error("database table is locked");
          exec(sql);
        },
      });
    });

    it("drops the others and throws fn's own error, not the drop's", () => {
      expect(() =>
        withBound(db, () => {
          failDrop = true;
          throw new Error("what really went wrong");
        }),
      ).toThrow("what really went wrong");

      expect(tempTables()).toEqual(["performers"]);
    });

    it("throws the drop's error if fn succeeded, and the next call starts clean", () => {
      library(db);
      expect(() =>
        withBound(db, () => {
          failDrop = true;
        }),
      ).toThrow("database table is locked");
      expect(tempTables()).toEqual(["performers"]);

      failDrop = false;
      expect(withBound(db, () => ids("artists_in_bound"))).toHaveLength(3);
      expect(tempTables()).toEqual([]);
    });
  });
});
