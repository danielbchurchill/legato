import { describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "../db.js";
import { computeAlbumRelations, computeArtistCollaborations, recomputeCollaborationEdges } from "./collaboration.js";

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

describe("recomputeCollaborationEdges", () => {
  function makeNode(db: Database.Database, type: string, title: string): number {
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
