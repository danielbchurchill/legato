import { describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "../db.js";
import { recomputeAllLayouts, recomputeAlbumsLayout, recomputeArtistsLayout, recomputeTracksLayout } from "./seed.js";

// computeClusteredSeeds' own properties (determinism, spread, decade/group
// separation, unknown-region handling) are covered by layout/cluster.spec.ts
// — this file covers the DB-reading orchestration on top: which nodes get
// fed to the cluster algorithm, at which granularity, from which edges.

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
  insertEdge(db, recording, artist, "performed_by");
  insertEdge(db, recording, release, "appears_on");
  insertEdge(db, recording, year, "released_in");
  return { artist, release, year, recording };
}

describe("recomputeTracksLayout", () => {
  it("positions a recording, but not its connected artist/release/year nodes", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO library_roots (path) VALUES ('/fake')").run();
    const { artist, release, year, recording } = buildLibrary(db);

    recomputeTracksLayout(db);

    const recordingRow = db
      .prepare("SELECT seed_x, seed_y FROM positions WHERE node_id = ? AND granularity = 'tracks'")
      .get(recording) as { seed_x: number; seed_y: number } | undefined;
    expect(recordingRow).toBeDefined();
    expect(Number.isFinite(recordingRow!.seed_x)).toBe(true);
    expect(Number.isFinite(recordingRow!.seed_y)).toBe(true);

    for (const nodeId of [artist, release, year]) {
      const row = db.prepare("SELECT 1 FROM positions WHERE node_id = ? AND granularity = 'tracks'").get(nodeId);
      expect(row).toBeUndefined();
    }
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

    const pos = (id: number) =>
      db.prepare("SELECT seed_x, seed_y FROM positions WHERE node_id = ? AND granularity = 'tracks'").get(id) as {
        seed_x: number;
        seed_y: number;
      };
    const [p1, p2, p3] = [pos(r1), pos(r2), pos(r3)];

    const distSameArtist = Math.hypot(p1.seed_x - p2.seed_x, p1.seed_y - p2.seed_y);
    const distDifferentArtist = Math.hypot(p1.seed_x - p3.seed_x, p1.seed_y - p3.seed_y);
    expect(distSameArtist).toBeLessThan(distDifferentArtist);
  });
});

describe("recomputeAlbumsLayout", () => {
  it("positions an album entity using its primary artist and year_min", () => {
    const db = openDb(":memory:");
    const artist = makeNode(db, "artist", "The Beatles");
    const release = makeNode(db, "release", "Abbey Road");
    db.prepare(
      "INSERT INTO albums (node_id, primary_artist_node_id, track_count, total_duration_ms, year_min, year_max) VALUES (?, ?, 1, 0, 1969, 1969)",
    ).run(release, artist);

    recomputeAlbumsLayout(db);

    const row = db
      .prepare("SELECT seed_x, seed_y FROM positions WHERE node_id = ? AND granularity = 'albums'")
      .get(release) as { seed_x: number; seed_y: number } | undefined;
    expect(row).toBeDefined();
    expect(Number.isFinite(row!.seed_x)).toBe(true);
  });

  it("does not write a 'tracks' position — granularities stay independent", () => {
    const db = openDb(":memory:");
    const artist = makeNode(db, "artist", "The Beatles");
    const release = makeNode(db, "release", "Abbey Road");
    db.prepare(
      "INSERT INTO albums (node_id, primary_artist_node_id, track_count, total_duration_ms, year_min, year_max) VALUES (?, ?, 1, 0, 1969, 1969)",
    ).run(release, artist);

    recomputeAlbumsLayout(db);

    const tracksRow = db
      .prepare("SELECT 1 FROM positions WHERE node_id = ? AND granularity = 'tracks'")
      .get(release);
    expect(tracksRow).toBeUndefined();
  });
});

describe("recomputeArtistsLayout", () => {
  it("positions an artist entity at the decade of their earliest release", () => {
    const db = openDb(":memory:");
    const artist = makeNode(db, "artist", "The Beatles");
    const release = makeNode(db, "release", "Please Please Me");
    db.prepare("INSERT INTO artists (node_id, track_count, album_count) VALUES (?, 14, 1)").run(artist);
    db.prepare(
      "INSERT INTO albums (node_id, primary_artist_node_id, track_count, total_duration_ms, year_min, year_max) VALUES (?, ?, 14, 0, 1963, 1963)",
    ).run(release, artist);

    recomputeArtistsLayout(db);

    const row = db
      .prepare("SELECT seed_x, seed_y FROM positions WHERE node_id = ? AND granularity = 'artists'")
      .get(artist) as { seed_x: number; seed_y: number } | undefined;
    expect(row).toBeDefined();
    expect(Number.isFinite(row!.seed_x)).toBe(true);
  });

  it("still positions an artist with no albums at all, without throwing", () => {
    const db = openDb(":memory:");
    const artist = makeNode(db, "artist", "Nobody's Heard Of Them");
    db.prepare("INSERT INTO artists (node_id, track_count, album_count) VALUES (?, 0, 0)").run(artist);

    expect(() => recomputeArtistsLayout(db)).not.toThrow();
    const row = db
      .prepare("SELECT 1 FROM positions WHERE node_id = ? AND granularity = 'artists'")
      .get(artist);
    expect(row).toBeDefined();
  });
});

describe("recomputeAllLayouts", () => {
  it("computes all three granularities in one call", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO library_roots (path) VALUES ('/fake')").run();
    const artist = makeNode(db, "artist", "The Beatles");
    const release = makeNode(db, "release", "Abbey Road");
    const recording = makeNode(db, "recording", "Come Together");
    db.prepare("INSERT INTO recordings (node_id) VALUES (?)").run(recording);
    db.prepare(
      "INSERT INTO files (recording_node_id, library_root_id, file_path, file_mtime, file_size) VALUES (?, (SELECT id FROM library_roots LIMIT 1), '/fake/x.flac', datetime('now'), 0)",
    ).run(recording);
    insertEdge(db, recording, artist, "performed_by");
    insertEdge(db, recording, release, "appears_on");
    db.prepare(
      "INSERT INTO albums (node_id, primary_artist_node_id, track_count, total_duration_ms) VALUES (?, ?, 1, 0)",
    ).run(release, artist);
    db.prepare("INSERT INTO artists (node_id, track_count, album_count) VALUES (?, 1, 1)").run(artist);

    recomputeAllLayouts(db);

    const granularities = db
      .prepare("SELECT DISTINCT granularity FROM positions ORDER BY granularity")
      .all() as { granularity: string }[];
    expect(granularities.map((g) => g.granularity)).toEqual(["albums", "artists", "tracks"]);
  });
});
