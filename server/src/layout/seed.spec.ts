import { describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "../db.js";
import { recomputeAllLayouts, recomputeTracksLayout } from "./seed.js";

// computeClusteredSeeds' own properties (determinism, spread, decade/group
// separation, unknown-region handling) are covered by layout/cluster.spec.ts
// — this file covers the DB-reading orchestration on top: which nodes get
// fed to the cluster algorithm, at which granularity, from which edges, and
// (since 2026-08-29's combined graph) how release/artist entities get
// seeded from their recordings' positions.

function makeNode(db: Database.Database, type: string, title: string): number {
  const row = db.prepare("INSERT INTO nodes (type, title) VALUES (?, ?) RETURNING id").get(type, title) as {
    id: number;
  };
  return row.id;
}

function insertEdge(db: Database.Database, from: number, to: number, type: string): void {
  db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, ?, 'local')").run(from, to, type);
}

function buildLibrary(db: Database.Database) {
  const artist = makeNode(db, "artist", "The Beatles");
  const release = makeNode(db, "release", "Abbey Road");
  const year = makeNode(db, "year", "1969");
  const recording = makeNode(db, "recording", "Come Together");
  db.prepare("INSERT INTO recordings (node_id, canonical_duration_ms) VALUES (?, ?)").run(recording, 259000);
  db.prepare("INSERT INTO files (recording_node_id, library_root_id, file_path, file_mtime, file_size) VALUES (?, (SELECT id FROM library_roots LIMIT 1), '/fake/x.flac', datetime('now'), 0)").run(recording);
  db.prepare(
    "INSERT INTO albums (node_id, primary_artist_node_id, track_count, total_duration_ms, year_min, year_max) VALUES (?, ?, 1, 259000, 1969, 1969)",
  ).run(release, artist);
  db.prepare("INSERT INTO artists (node_id, track_count, album_count) VALUES (?, 1, 1)").run(artist);
  insertEdge(db, recording, artist, "performed_by");
  insertEdge(db, recording, release, "appears_on");
  insertEdge(db, recording, year, "released_in");
  return { artist, release, year, recording };
}

function pos(db: Database.Database, nodeId: number) {
  return db.prepare("SELECT seed_x, seed_y FROM positions WHERE node_id = ? AND granularity = 'tracks'").get(nodeId) as
    | { seed_x: number; seed_y: number }
    | undefined;
}

describe("recomputeTracksLayout", () => {
  it("positions a recording and its release/artist, but not its year node", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO library_roots (path) VALUES ('/fake')").run();
    const { artist, release, year, recording } = buildLibrary(db);

    recomputeTracksLayout(db);

    for (const nodeId of [recording, artist, release]) {
      const row = pos(db, nodeId);
      expect(row).toBeDefined();
      expect(Number.isFinite(row!.seed_x)).toBe(true);
      expect(Number.isFinite(row!.seed_y)).toBe(true);
    }
    expect(pos(db, year)).toBeUndefined();
  });

  it("seeds a release at the centroid of its recordings' positions", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO library_roots (path) VALUES ('/fake')").run();
    const artist = makeNode(db, "artist", "The Beatles");
    const release = makeNode(db, "release", "Abbey Road");
    db.prepare(
      "INSERT INTO albums (node_id, primary_artist_node_id, track_count, total_duration_ms, year_min, year_max) VALUES (?, ?, 2, 0, 1969, 1969)",
    ).run(release, artist);
    db.prepare("INSERT INTO artists (node_id, track_count, album_count) VALUES (?, 2, 1)").run(artist);
    const libraryRootId = db.prepare("SELECT id FROM library_roots LIMIT 1").get() as { id: number };
    const r1 = makeNode(db, "recording", "Track 1");
    const r2 = makeNode(db, "recording", "Track 2");
    for (const r of [r1, r2]) {
      db.prepare("INSERT INTO recordings (node_id) VALUES (?)").run(r);
      db.prepare(
        "INSERT INTO files (recording_node_id, library_root_id, file_path, file_mtime, file_size) VALUES (?, ?, ?, datetime('now'), 0)",
      ).run(r, libraryRootId.id, `/fake/${r}.flac`);
      insertEdge(db, r, artist, "performed_by");
      insertEdge(db, r, release, "appears_on");
    }

    recomputeTracksLayout(db);

    const [p1, p2, releasePos] = [pos(db, r1)!, pos(db, r2)!, pos(db, release)!];
    expect(releasePos.seed_x).toBeCloseTo((p1.seed_x + p2.seed_x) / 2);
    expect(releasePos.seed_y).toBeCloseTo((p1.seed_y + p2.seed_y) / 2);
  });

  it("still positions a release/artist entity with no recordings at all, without throwing", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO library_roots (path) VALUES ('/fake')").run();
    const artist = makeNode(db, "artist", "Nobody's Heard Of Them");
    const release = makeNode(db, "release", "Unreleased");
    db.prepare("INSERT INTO artists (node_id, track_count, album_count) VALUES (?, 0, 0)").run(artist);
    db.prepare(
      "INSERT INTO albums (node_id, primary_artist_node_id, track_count, total_duration_ms) VALUES (?, NULL, 0, 0)",
    ).run(release);

    expect(() => recomputeTracksLayout(db)).not.toThrow();
    expect(pos(db, artist)).toBeDefined();
    expect(pos(db, release)).toBeDefined();
  });

  it("clusters two recordings by the same artist near each other, apart from a third artist", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO library_roots (path) VALUES ('/fake')").run();

    const artistA = makeNode(db, "artist", "Artist A");
    const artistB = makeNode(db, "artist", "Artist B");
    const year = makeNode(db, "year", "1970");
    const r1 = makeNode(db, "recording", "Track 1");
    const r2 = makeNode(db, "recording", "Track 2");
    const r3 = makeNode(db, "recording", "Track 3");
    const libraryRootId = db.prepare("SELECT id FROM library_roots LIMIT 1").get() as { id: number };
    for (const r of [r1, r2, r3]) {
      db.prepare("INSERT INTO recordings (node_id) VALUES (?)").run(r);
      db.prepare(
        "INSERT INTO files (recording_node_id, library_root_id, file_path, file_mtime, file_size) VALUES (?, ?, ?, datetime('now'), 0)",
      ).run(r, libraryRootId.id, `/fake/${r}.flac`);
    }
    insertEdge(db, r1, artistA, "performed_by");
    insertEdge(db, r1, year, "released_in");
    insertEdge(db, r2, artistA, "performed_by");
    insertEdge(db, r2, year, "released_in");
    insertEdge(db, r3, artistB, "performed_by");
    insertEdge(db, r3, year, "released_in");

    recomputeTracksLayout(db);

    const [p1, p2, p3] = [pos(db, r1)!, pos(db, r2)!, pos(db, r3)!];

    const distSameArtist = Math.hypot(p1.seed_x - p2.seed_x, p1.seed_y - p2.seed_y);
    const distDifferentArtist = Math.hypot(p1.seed_x - p3.seed_x, p1.seed_y - p3.seed_y);
    expect(distSameArtist).toBeLessThan(distDifferentArtist);
  });
});

describe("credit node seeding (#24)", () => {
  it("seeds a credit node at the centroid of the recordings that credit it as producer or engineer", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO library_roots (path) VALUES ('/fake')").run();
    const artist = makeNode(db, "artist", "The Beatles");
    const producer = makeNode(db, "credit", "George Martin");
    const libraryRootId = db.prepare("SELECT id FROM library_roots LIMIT 1").get() as { id: number };
    const r1 = makeNode(db, "recording", "Come Together");
    const r2 = makeNode(db, "recording", "Something");
    for (const r of [r1, r2]) {
      db.prepare("INSERT INTO recordings (node_id) VALUES (?)").run(r);
      db.prepare(
        "INSERT INTO files (recording_node_id, library_root_id, file_path, file_mtime, file_size) VALUES (?, ?, ?, datetime('now'), 0)",
      ).run(r, libraryRootId.id, `/fake/${r}.flac`);
      insertEdge(db, r, artist, "performed_by");
    }
    insertEdge(db, r1, producer, "produced_by");
    insertEdge(db, r2, producer, "engineered_by");

    recomputeTracksLayout(db);

    const [p1, p2, producerPos] = [pos(db, r1)!, pos(db, r2)!, pos(db, producer)!];
    expect(producerPos.seed_x).toBeCloseTo((p1.seed_x + p2.seed_x) / 2);
    expect(producerPos.seed_y).toBeCloseTo((p1.seed_y + p2.seed_y) / 2);
  });

  it("does not position a credit node with no produced_by or engineered_by edge", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO library_roots (path) VALUES ('/fake')").run();
    const mixer = makeNode(db, "credit", "Someone Who Only Mixed");
    const { recording } = buildLibrary(db);
    insertEdge(db, recording, mixer, "mixed_by");

    recomputeTracksLayout(db);

    expect(pos(db, mixer)).toBeUndefined();
  });

  it("drops a credit node's position once its last produced_by/engineered_by edge is gone", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO library_roots (path) VALUES ('/fake')").run();
    const producer = makeNode(db, "credit", "George Martin");
    const { recording } = buildLibrary(db);
    insertEdge(db, recording, producer, "produced_by");
    recomputeTracksLayout(db);
    expect(pos(db, producer)).toBeDefined();

    db.prepare("DELETE FROM edges WHERE to_node = ? AND type = 'produced_by'").run(producer);
    recomputeTracksLayout(db);

    expect(pos(db, producer)).toBeUndefined();
  });
});

describe("nodePositionsLocked setting", () => {
  it("leaves an existing seed position untouched on recompute while locked", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO library_roots (path) VALUES ('/fake')").run();
    const { recording } = buildLibrary(db);

    recomputeTracksLayout(db);
    const before = db
      .prepare("SELECT seed_x, seed_y, seed_version FROM positions WHERE node_id = ? AND granularity = 'tracks'")
      .get(recording) as { seed_x: number; seed_y: number; seed_version: number };

    db.prepare("INSERT INTO settings (key, value) VALUES ('nodePositionsLocked', 'true')").run();

    // A second artist changes what recomputeTracksLayout would otherwise
    // cluster this recording toward — if lock were a no-op, the seed would
    // move and/or seed_version would bump.
    const artistB = makeNode(db, "artist", "Artist B");
    db.prepare("DELETE FROM edges WHERE from_node = ? AND type = 'performed_by'").run(recording);
    insertEdge(db, recording, artistB, "performed_by");
    recomputeTracksLayout(db);

    const after = db
      .prepare("SELECT seed_x, seed_y, seed_version FROM positions WHERE node_id = ? AND granularity = 'tracks'")
      .get(recording) as { seed_x: number; seed_y: number; seed_version: number };
    expect(after).toEqual(before);
  });

  it("still seeds a brand new node while locked, so a rescan can't drop it from the graph", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO library_roots (path) VALUES ('/fake')").run();
    db.prepare("INSERT INTO settings (key, value) VALUES ('nodePositionsLocked', 'true')").run();

    const { recording } = buildLibrary(db);
    recomputeTracksLayout(db);

    const row = pos(db, recording);
    expect(row).toBeDefined();
    expect(Number.isFinite(row!.seed_x)).toBe(true);
  });
});

describe("recomputeAllLayouts", () => {
  it("computes the combined graph's positions in one call", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO library_roots (path) VALUES ('/fake')").run();
    buildLibrary(db);

    recomputeAllLayouts(db);

    const granularities = db
      .prepare("SELECT DISTINCT granularity FROM positions ORDER BY granularity")
      .all() as { granularity: string }[];
    expect(granularities.map((g) => g.granularity)).toEqual(["tracks"]);
  });
});
