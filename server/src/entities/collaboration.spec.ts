import { describe, expect, it } from "bun:test";
import type { Database } from "../sqlite.js";
import { openDb } from "../db.js";
import {
  computeAlbumRelations,
  computeArtistAffinities,
  computeArtistCollaborations,
  recomputeCollaborationEdges,
} from "./collaboration.js";

describe("computeArtistCollaborations", () => {
  it("pairs every artist sharing a recording exactly once", () => {
    const performerEdges = [
      { fromNode: 1, toNode: 100 }, // recording 1: artists 100, 200, 300
      { fromNode: 1, toNode: 200 },
      { fromNode: 1, toNode: 300 },
      { fromNode: 2, toNode: 100 }, // recording 2: artists 100, 200 again
      { fromNode: 2, toNode: 200 },
    ];

    const edges = computeArtistCollaborations(performerEdges);
    const pairs = edges.map((e) => `${e.fromNode}-${e.toNode}`).sort();
    expect(pairs).toEqual(["100-200", "100-300", "200-300"]); // 100-200 not duplicated
    expect(edges.every((e) => e.type === "collaborated_with")).toBe(true);
  });

  it("produces nothing for a recording with a single performer", () => {
    expect(computeArtistCollaborations([{ fromNode: 1, toNode: 100 }])).toEqual([]);
  });
});

describe("computeAlbumRelations", () => {
  it("links albums sharing a primary artist via same_artist", () => {
    const albums = [
      { nodeId: 10, primaryArtistNodeId: 500 },
      { nodeId: 11, primaryArtistNodeId: 500 },
      { nodeId: 12, primaryArtistNodeId: 600 },
    ];
    const edges = computeAlbumRelations(albums, new Map());
    expect(edges).toEqual([{ fromNode: 10, toNode: 11, type: "same_artist" }]);
  });

  it("links albums sharing a dominant label via same_label", () => {
    const albums = [
      { nodeId: 10, primaryArtistNodeId: null },
      { nodeId: 11, primaryArtistNodeId: null },
    ];
    const albumLabel = new Map([
      [10, 900],
      [11, 900],
    ]);
    const edges = computeAlbumRelations(albums, albumLabel);
    expect(edges).toEqual([{ fromNode: 10, toNode: 11, type: "same_label" }]);
  });

  it("produces both relations independently when albums share both", () => {
    const albums = [
      { nodeId: 10, primaryArtistNodeId: 500 },
      { nodeId: 11, primaryArtistNodeId: 500 },
    ];
    const albumLabel = new Map([
      [10, 900],
      [11, 900],
    ]);
    const edges = computeAlbumRelations(albums, albumLabel);
    expect(edges).toHaveLength(2);
    expect(edges.map((e) => e.type).sort()).toEqual(["same_artist", "same_label"]);
  });
});

describe("computeArtistAffinities — G-7's wider artist-graph signals", () => {
  it("connects two artists whose albums share a dominant label, even with no shared recording", () => {
    const albums = [
      { nodeId: 10, primaryArtistNodeId: 500 },
      { nodeId: 11, primaryArtistNodeId: 600 },
    ];
    const albumLabel = new Map([
      [10, 900],
      [11, 900],
    ]);
    const edges = computeArtistAffinities(albums, albumLabel, new Map(), [], []);
    expect(edges).toEqual([{ fromNode: 500, toNode: 600, type: "collaborated_with", affinityReason: "same_label" }]);
  });

  it("connects two artists whose albums land in the same era (decade), even on different labels", () => {
    const albums = [
      { nodeId: 10, primaryArtistNodeId: 500 },
      { nodeId: 11, primaryArtistNodeId: 600 },
    ];
    const albumEraDecade = new Map([
      [10, 1960],
      [11, 1960],
    ]);
    const edges = computeArtistAffinities(albums, new Map(), albumEraDecade, [], []);
    expect(edges).toEqual([{ fromNode: 500, toNode: 600, type: "collaborated_with", affinityReason: "same_era" }]);
  });

  it("does not connect artists whose albums land in different decades", () => {
    const albums = [
      { nodeId: 10, primaryArtistNodeId: 500 },
      { nodeId: 11, primaryArtistNodeId: 600 },
    ];
    const albumEraDecade = new Map([
      [10, 1960],
      [11, 1990],
    ]);
    expect(computeArtistAffinities(albums, new Map(), albumEraDecade, [], [])).toEqual([]);
  });

  it("connects two artists whose recordings share a producer, even on different albums/labels/eras", () => {
    const performerEdges = [
      { fromNode: 1, toNode: 500 }, // recording 1 (artist 500)
      { fromNode: 2, toNode: 600 }, // recording 2 (artist 600)
    ];
    const creditEdges = [
      { recordingNodeId: 1, creditNodeId: 999 },
      { recordingNodeId: 2, creditNodeId: 999 },
    ];
    const edges = computeArtistAffinities([], new Map(), new Map(), performerEdges, creditEdges);
    expect(edges).toEqual([{ fromNode: 500, toNode: 600, type: "collaborated_with", affinityReason: "same_credit" }]);
  });

  it("ignores a credit on a recording with no performer edge to join against", () => {
    const creditEdges = [{ recordingNodeId: 1, creditNodeId: 999 }];
    expect(computeArtistAffinities([], new Map(), new Map(), [], creditEdges)).toEqual([]);
  });

  it("skips albums with no primary artist", () => {
    const albums = [{ nodeId: 10, primaryArtistNodeId: null }];
    const albumLabel = new Map([[10, 900]]);
    expect(computeArtistAffinities(albums, albumLabel, new Map(), [], [])).toEqual([]);
  });
});

describe("recomputeCollaborationEdges", () => {
  function makeNode(db: Database, type: string, title: string): number {
    const row = db.prepare("INSERT INTO nodes (type, title) VALUES (?, ?) RETURNING id").get(type, title) as {
      id: number;
    };
    return row.id;
  }

  it("derives real collaboration/relation edges from real edges and album aggregates", () => {
    const db = openDb(":memory:");

    const artistA = makeNode(db, "artist", "Artist A");
    const artistB = makeNode(db, "artist", "Artist B");
    const release = makeNode(db, "release", "Split EP");
    const label = makeNode(db, "label", "Some Label");
    const recording = makeNode(db, "recording", "Duet");

    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'performed_by', 'local')").run(
      recording,
      artistA,
    );
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'featured_artist', 'local')").run(
      recording,
      artistB,
    );
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'appears_on', 'local')").run(
      recording,
      release,
    );
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'released_on', 'local')").run(
      recording,
      label,
    );
    db.prepare(
      "INSERT INTO albums (node_id, primary_artist_node_id, track_count, total_duration_ms) VALUES (?, ?, 1, 0)",
    ).run(release, artistA);

    recomputeCollaborationEdges(db);

    const collab = db
      .prepare("SELECT from_node, to_node FROM edges WHERE type = 'collaborated_with'")
      .all() as { from_node: number; to_node: number }[];
    expect(collab).toHaveLength(1);
    expect([collab[0].from_node, collab[0].to_node].sort((a, b) => a - b)).toEqual(
      [artistA, artistB].sort((a, b) => a - b),
    );
  });

  it("is idempotent — re-running with no data change doesn't accumulate duplicate edges", () => {
    const db = openDb(":memory:");
    const artistA = makeNode(db, "artist", "Artist A");
    const artistB = makeNode(db, "artist", "Artist B");
    const recording = makeNode(db, "recording", "Duet");
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'performed_by', 'local')").run(
      recording,
      artistA,
    );
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'featured_artist', 'local')").run(
      recording,
      artistB,
    );

    recomputeCollaborationEdges(db);
    recomputeCollaborationEdges(db);

    const count = db.prepare("SELECT COUNT(*) AS n FROM edges WHERE type = 'collaborated_with'").get() as {
      n: number;
    };
    expect(count.n).toBe(1);
  });

  it("connects two artists via a shared producer credit end to end, with no shared recording", () => {
    const db = openDb(":memory:");
    const artistA = makeNode(db, "artist", "Artist A");
    const artistB = makeNode(db, "artist", "Artist B");
    const producer = makeNode(db, "credit", "Some Producer");
    const trackA = makeNode(db, "recording", "Track A");
    const trackB = makeNode(db, "recording", "Track B");

    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'performed_by', 'local')").run(
      trackA,
      artistA,
    );
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'performed_by', 'local')").run(
      trackB,
      artistB,
    );
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'produced_by', 'musicbrainz')").run(
      trackA,
      producer,
    );
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'produced_by', 'musicbrainz')").run(
      trackB,
      producer,
    );

    recomputeCollaborationEdges(db);

    const edge = db
      .prepare("SELECT 1 FROM edges WHERE type = 'collaborated_with' AND from_node = ? AND to_node = ?")
      .get(artistA, artistB);
    expect(edge).toBeDefined();
  });

  it("produces exactly one edge for a pair connected by both direct collaboration and a shared label", () => {
    const db = openDb(":memory:");
    const artistA = makeNode(db, "artist", "Artist A");
    const artistB = makeNode(db, "artist", "Artist B");
    const recording = makeNode(db, "recording", "Duet");
    const releaseA = makeNode(db, "release", "Solo Album A");
    const releaseB = makeNode(db, "release", "Solo Album B");
    const label = makeNode(db, "label", "Shared Label");

    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'performed_by', 'local')").run(
      recording,
      artistA,
    );
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'featured_artist', 'local')").run(
      recording,
      artistB,
    );
    db.prepare(
      "INSERT INTO albums (node_id, primary_artist_node_id, track_count) VALUES (?, ?, 1)",
    ).run(releaseA, artistA);
    db.prepare(
      "INSERT INTO albums (node_id, primary_artist_node_id, track_count) VALUES (?, ?, 1)",
    ).run(releaseB, artistB);
    const soloA = makeNode(db, "recording", "Solo A Track");
    const soloB = makeNode(db, "recording", "Solo B Track");
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'appears_on', 'local')").run(
      soloA,
      releaseA,
    );
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'appears_on', 'local')").run(
      soloB,
      releaseB,
    );
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'released_on', 'local')").run(
      soloA,
      label,
    );
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'released_on', 'local')").run(
      soloB,
      label,
    );

    recomputeCollaborationEdges(db);

    const count = db
      .prepare("SELECT COUNT(*) AS n FROM edges WHERE type = 'collaborated_with' AND from_node = ? AND to_node = ?")
      .get(artistA, artistB) as { n: number };
    expect(count.n).toBe(1);
  });

  it("persists affinityReason as the edge's label column, real ties as null", () => {
    const db = openDb(":memory:");
    const artistA = makeNode(db, "artist", "Artist A");
    const artistB = makeNode(db, "artist", "Artist B");
    const artistC = makeNode(db, "artist", "Artist C");
    const recording = makeNode(db, "recording", "Duet");
    const releaseA = makeNode(db, "release", "Solo Album A");
    const releaseC = makeNode(db, "release", "Solo Album C");
    const label = makeNode(db, "label", "Shared Label");

    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'performed_by', 'local')").run(
      recording,
      artistA,
    );
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'featured_artist', 'local')").run(
      recording,
      artistB,
    );
    db.prepare("INSERT INTO albums (node_id, primary_artist_node_id, track_count) VALUES (?, ?, 1)").run(
      releaseA,
      artistA,
    );
    db.prepare("INSERT INTO albums (node_id, primary_artist_node_id, track_count) VALUES (?, ?, 1)").run(
      releaseC,
      artistC,
    );
    const soloA = makeNode(db, "recording", "Solo A Track");
    const soloC = makeNode(db, "recording", "Solo C Track");
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'appears_on', 'local')").run(
      soloA,
      releaseA,
    );
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'appears_on', 'local')").run(
      soloC,
      releaseC,
    );
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'released_on', 'local')").run(
      soloA,
      label,
    );
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'released_on', 'local')").run(
      soloC,
      label,
    );

    recomputeCollaborationEdges(db);

    const real = db
      .prepare("SELECT label FROM edges WHERE type = 'collaborated_with' AND from_node = ? AND to_node = ?")
      .get(artistA, artistB) as { label: string | null };
    expect(real.label).toBeNull();

    const affinityOnly = db
      .prepare("SELECT label FROM edges WHERE type = 'collaborated_with' AND from_node = ? AND to_node = ?")
      .get(artistA, artistC) as { label: string | null };
    expect(affinityOnly.label).toBe("same_label");
  });

  it("never touches deriveLocalEdges's own source='local' rows for recording nodes", () => {
    const db = openDb(":memory:");
    const artist = makeNode(db, "artist", "Artist A");
    const recording = makeNode(db, "recording", "Solo Track");
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'performed_by', 'local')").run(
      recording,
      artist,
    );

    recomputeCollaborationEdges(db);

    const stillThere = db
      .prepare("SELECT COUNT(*) AS n FROM edges WHERE from_node = ? AND type = 'performed_by'")
      .get(recording) as { n: number };
    expect(stillThere.n).toBe(1);
  });
});

// Issue #281: written as a diff, so recompute's worker holds the write lock
// only for what changed.
describe("recomputeCollaborationEdges — writing only what changed", () => {
  function makeNode(db: Database, type: string, title: string): number {
    return (db.prepare("INSERT INTO nodes (type, title) VALUES (?, ?) RETURNING id").get(type, title) as { id: number }).id;
  }
  const collaborations = (db: Database) =>
    db
      .prepare("SELECT id, from_node AS fromNode, to_node AS toNode, source, label FROM edges WHERE type = 'collaborated_with' ORDER BY id")
      .all();

  it("keeps an unchanged edge's row, and removes one that's no longer true, a duplicate or another source's", () => {
    const db = openDb(":memory:");
    const a = makeNode(db, "artist", "A");
    const b = makeNode(db, "artist", "B");
    const c = makeNode(db, "artist", "C");
    const recording = makeNode(db, "recording", "Duet");
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'performed_by', 'local')").run(recording, a);
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'featured_artist', 'local')").run(recording, b);

    recomputeCollaborationEdges(db);
    const first = collaborations(db);
    expect(first).toHaveLength(1);

    const insert = db.prepare("INSERT INTO edges (from_node, to_node, type, source, label) VALUES (?, ?, 'collaborated_with', ?, NULL)");
    insert.run(a, b, "local"); // a duplicate
    insert.run(a, c, "local"); // no longer true
    insert.run(b, c, "manual"); // what the wholesale delete always removed too
    recomputeCollaborationEdges(db);

    expect(collaborations(db)).toEqual(first);
  });
});
