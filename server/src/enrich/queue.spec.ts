import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "../db.js";
import {
  enqueueArtistImageLookupIfNeeded,
  enqueueCoverArtLookupIfNeeded,
  enqueueDescriptionLookupIfNeeded,
  enqueueEnrichmentIfNeeded,
  isEnrichmentEnabled,
} from "./queue.js";

let db: Database.Database;

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
