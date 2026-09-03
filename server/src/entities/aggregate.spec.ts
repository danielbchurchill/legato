import { describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "../db.js";
import {
  computeAlbumAggregates,
  computeArtistAggregates,
  listArtistReleases,
  recomputeEntities,
  type EdgeRef,
} from "./aggregate.js";

describe("computeAlbumAggregates", () => {
  it("sums duration and spans years across a release's tracks", () => {
    const appearsOn: EdgeRef[] = [
      { fromNode: 1, toNode: 100 },
      { fromNode: 2, toNode: 100 },
    ];
    const performedBy: EdgeRef[] = [
      { fromNode: 1, toNode: 200 },
      { fromNode: 2, toNode: 200 },
    ];
    const durationMs = new Map([
      [1, 200000],
      [2, 180000],
    ]);
    const year = new Map([
      [1, 1969],
      [2, 1970],
    ]);

    const [album] = computeAlbumAggregates(appearsOn, performedBy, durationMs, year);
    expect(album).toEqual({
      nodeId: 100,
      primaryArtistNodeId: 200,
      trackCount: 2,
      totalDurationMs: 380000,
      yearMin: 1969,
      yearMax: 1970,
    });
  });

  it("picks the artist credited on the most tracks, ties broken by lowest node id", () => {
    const appearsOn: EdgeRef[] = [
      { fromNode: 1, toNode: 100 },
      { fromNode: 2, toNode: 100 },
      { fromNode: 3, toNode: 100 },
    ];
    // Artist 200 on two tracks, artist 300 on one — 200 should win.
    const performedBy: EdgeRef[] = [
      { fromNode: 1, toNode: 200 },
      { fromNode: 2, toNode: 200 },
      { fromNode: 3, toNode: 300 },
    ];

    const [album] = computeAlbumAggregates(appearsOn, performedBy, new Map(), new Map());
    expect(album.primaryArtistNodeId).toBe(200);
  });

  it("treats a compilation with no dominant artist and no duration/year data gracefully", () => {
    const appearsOn: EdgeRef[] = [{ fromNode: 1, toNode: 100 }];
    const [album] = computeAlbumAggregates(appearsOn, [], new Map(), new Map());
    expect(album.primaryArtistNodeId).toBeNull();
    expect(album.totalDurationMs).toBe(0);
    expect(album.yearMin).toBeNull();
    expect(album.yearMax).toBeNull();
  });
});

describe("computeArtistAggregates", () => {
  it("counts distinct tracks and distinct albums per artist", () => {
    const appearsOn: EdgeRef[] = [
      { fromNode: 1, toNode: 100 },
      { fromNode: 2, toNode: 100 },
      { fromNode: 3, toNode: 101 },
    ];
    const performedBy: EdgeRef[] = [
      { fromNode: 1, toNode: 200 },
      { fromNode: 2, toNode: 200 },
      { fromNode: 3, toNode: 200 },
    ];

    const [artist] = computeArtistAggregates(appearsOn, performedBy);
    expect(artist).toEqual({ nodeId: 200, trackCount: 3, albumCount: 2 });
  });

  it("counts a loose track with no release edge toward trackCount but not albumCount", () => {
    const performedBy: EdgeRef[] = [{ fromNode: 1, toNode: 200 }];
    const [artist] = computeArtistAggregates([], performedBy);
    expect(artist).toEqual({ nodeId: 200, trackCount: 1, albumCount: 0 });
  });

  it("creates an entity for an artist credited only as a featured guest, never as the primary performer", () => {
    // Regression: confirmed live on the real library — nodes with a
    // collaborated_with edge (entities/collaboration.ts) but no
    // performed_by credit of their own never got an artists row, so they
    // silently never appeared in GET /nodes?granularity=artists at all.
    // The caller is responsible for passing performed_by + featured_artist
    // combined as performerEdges.
    const appearsOn: EdgeRef[] = [{ fromNode: 1, toNode: 100 }];
    const performerEdges: EdgeRef[] = [
      { fromNode: 1, toNode: 200 }, // primary performer
      { fromNode: 1, toNode: 300 }, // featured guest, never a primary performer anywhere
    ];

    const artists = computeArtistAggregates(appearsOn, performerEdges);
    const featuredGuest = artists.find((a) => a.nodeId === 300);
    expect(featuredGuest).toEqual({ nodeId: 300, trackCount: 1, albumCount: 1 });
  });
});

describe("recomputeEntities", () => {
  let db: Database.Database;

  function makeNode(type: string, title: string): number {
    const row = db.prepare("INSERT INTO nodes (type, title) VALUES (?, ?) RETURNING id").get(type, title) as {
      id: number;
    };
    return row.id;
  }

  it("upserts album/artist rows from real edges and recording durations", () => {
    db = openDb(":memory:");

    const artist = makeNode("artist", "The Beatles");
    const release = makeNode("release", "Abbey Road");
    const year = makeNode("year", "1969");
    const recording = makeNode("recording", "Come Together");
    db.prepare("INSERT INTO recordings (node_id, canonical_duration_ms) VALUES (?, ?)").run(recording, 259000);

    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'appears_on', 'local')").run(
      recording,
      release,
    );
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'performed_by', 'local')").run(
      recording,
      artist,
    );
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'released_in', 'local')").run(
      recording,
      year,
    );

    recomputeEntities(db);

    const albumRow = db.prepare("SELECT * FROM albums WHERE node_id = ?").get(release) as {
      primary_artist_node_id: number;
      track_count: number;
      total_duration_ms: number;
      year_min: number;
      year_max: number;
    };
    expect(albumRow.primary_artist_node_id).toBe(artist);
    expect(albumRow.track_count).toBe(1);
    expect(albumRow.total_duration_ms).toBe(259000);
    expect(albumRow.year_min).toBe(1969);
    expect(albumRow.year_max).toBe(1969);

    const artistRow = db.prepare("SELECT * FROM artists WHERE node_id = ?").get(artist) as {
      track_count: number;
      album_count: number;
    };
    expect(artistRow.track_count).toBe(1);
    expect(artistRow.album_count).toBe(1);
  });

  // The exact shape a credit fix produces: "JPEGMAFIA; Danny Brown" was one
  // artist node, re-deriving edges moves its recordings onto two real ones,
  // and the node that started it all must not linger on the graph.
  it("drops an artist row once nothing credits that node any more", () => {
    db = openDb(":memory:");

    const stale = makeNode("artist", "JPEGMAFIA; Danny Brown");
    const real = makeNode("artist", "JPEGMAFIA");
    const release = makeNode("release", "SCARING THE HOES");
    const recording = makeNode("recording", "Lean Beef Patty");
    db.prepare("INSERT INTO recordings (node_id) VALUES (?)").run(recording);
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'appears_on', 'local')").run(
      recording,
      release,
    );
    const creditTo = (artistNode: number) =>
      db
        .prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'performed_by', 'local')")
        .run(recording, artistNode);

    creditTo(stale);
    recomputeEntities(db);
    expect(db.prepare("SELECT node_id FROM artists WHERE node_id = ?").get(stale)).toBeTruthy();

    // Re-derive: the combined credit is gone, the real artist takes over.
    db.prepare("DELETE FROM edges WHERE type = 'performed_by'").run();
    creditTo(real);
    recomputeEntities(db);

    expect(db.prepare("SELECT node_id FROM artists WHERE node_id = ?").get(stale)).toBeUndefined();
    expect(db.prepare("SELECT node_id FROM artists WHERE node_id = ?").get(real)).toBeTruthy();
  });

  it("drops an album row once its last recording is gone", () => {
    db = openDb(":memory:");
    const artist = makeNode("artist", "Bob Dylan");
    const release = makeNode("release", "Blonde on Blonde");
    const recording = makeNode("recording", "Visions of Johanna");
    db.prepare("INSERT INTO recordings (node_id) VALUES (?)").run(recording);
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'appears_on', 'local')").run(
      recording,
      release,
    );
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'performed_by', 'local')").run(
      recording,
      artist,
    );

    recomputeEntities(db);
    expect(db.prepare("SELECT node_id FROM albums WHERE node_id = ?").get(release)).toBeTruthy();

    db.prepare("DELETE FROM edges").run();
    recomputeEntities(db);

    expect(db.prepare("SELECT node_id FROM albums WHERE node_id = ?").get(release)).toBeUndefined();
    expect(db.prepare("SELECT node_id FROM artists WHERE node_id = ?").get(artist)).toBeUndefined();
  });

  it("is idempotent — recomputing twice with no data change leaves the same rows", () => {
    db = openDb(":memory:");
    const artist = makeNode("artist", "Genesis Owusu");
    const release = makeNode("release", "Struggler");
    const recording = makeNode("recording", "Freak Boy");
    db.prepare("INSERT INTO recordings (node_id, canonical_duration_ms) VALUES (?, ?)").run(recording, 180000);
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'appears_on', 'local')").run(
      recording,
      release,
    );
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'performed_by', 'local')").run(
      recording,
      artist,
    );

    recomputeEntities(db);
    recomputeEntities(db);

    const count = db.prepare("SELECT COUNT(*) AS n FROM albums").get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("gives a featured-only artist a real artists table row", () => {
    db = openDb(":memory:");
    const primary = makeNode("artist", "The Beatles");
    const featured = makeNode("artist", "Billy Preston");
    const release = makeNode("release", "Let It Be");
    const recording = makeNode("recording", "Get Back");
    db.prepare("INSERT INTO recordings (node_id) VALUES (?)").run(recording);
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'appears_on', 'local')").run(
      recording,
      release,
    );
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'performed_by', 'local')").run(
      recording,
      primary,
    );
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'featured_artist', 'local')").run(
      recording,
      featured,
    );

    recomputeEntities(db);

    const row = db.prepare("SELECT track_count FROM artists WHERE node_id = ?").get(featured) as
      | { track_count: number }
      | undefined;
    expect(row).toBeDefined();
    expect(row?.track_count).toBe(1);
  });
});

describe("listArtistReleases", () => {
  let db: Database.Database;

  function makeNode(type: string, title: string): number {
    const row = db.prepare("INSERT INTO nodes (type, title) VALUES (?, ?) RETURNING id").get(type, title) as {
      id: number;
    };
    return row.id;
  }

  function credit(recordingNode: number, artistNode: number, type = "performed_by"): void {
    db.prepare(`INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, ?, 'local')`).run(
      recordingNode,
      artistNode,
      type,
    );
  }

  function appearsOn(recordingNode: number, releaseNode: number): void {
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'appears_on', 'local')").run(
      recordingNode,
      releaseNode,
    );
  }

  it("returns an artist's real releases, oldest first, with track count and year span", () => {
    db = openDb(":memory:");
    const artist = makeNode("artist", "Bob Dylan");

    const laterRelease = makeNode("release", "Blood on the Tracks");
    const laterRecording = makeNode("recording", "Tangled Up in Blue");
    db.prepare("INSERT INTO recordings (node_id, canonical_duration_ms) VALUES (?, ?)").run(laterRecording, 320000);
    appearsOn(laterRecording, laterRelease);
    credit(laterRecording, artist);
    const laterYear = makeNode("year", "1975");
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'released_in', 'local')").run(
      laterRecording,
      laterYear,
    );

    const earlierRelease = makeNode("release", "Highway 61 Revisited");
    const earlierRecording = makeNode("recording", "Like a Rolling Stone");
    db.prepare("INSERT INTO recordings (node_id, canonical_duration_ms) VALUES (?, ?)").run(
      earlierRecording,
      370000,
    );
    appearsOn(earlierRecording, earlierRelease);
    credit(earlierRecording, artist);
    const earlierYear = makeNode("year", "1965");
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'released_in', 'local')").run(
      earlierRecording,
      earlierYear,
    );

    recomputeEntities(db);

    const releases = listArtistReleases(db, artist);
    expect(releases.map((r) => r.title)).toEqual(["Highway 61 Revisited", "Blood on the Tracks"]);
    expect(releases[0]).toEqual({
      id: earlierRelease,
      title: "Highway 61 Revisited",
      trackCount: 1,
      totalDurationMs: 370000,
      yearMin: 1965,
      yearMax: 1965,
    });
  });

  it("excludes a release this artist only features on, never leads", () => {
    db = openDb(":memory:");
    const primary = makeNode("artist", "The Beatles");
    const featured = makeNode("artist", "Billy Preston");
    const release = makeNode("release", "Let It Be");
    const recording = makeNode("recording", "Get Back");
    db.prepare("INSERT INTO recordings (node_id) VALUES (?)").run(recording);
    appearsOn(recording, release);
    credit(recording, primary);
    credit(recording, featured, "featured_artist");

    recomputeEntities(db);

    expect(listArtistReleases(db, primary).map((r) => r.title)).toEqual(["Let It Be"]);
    expect(listArtistReleases(db, featured)).toEqual([]);
  });

  it("returns an empty array for an artist whose recordings never appeared on a release", () => {
    db = openDb(":memory:");
    const artist = makeNode("artist", "A Loose Single");
    const recording = makeNode("recording", "One-Off");
    db.prepare("INSERT INTO recordings (node_id) VALUES (?)").run(recording);
    credit(recording, artist);

    recomputeEntities(db);

    expect(listArtistReleases(db, artist)).toEqual([]);
  });
});
