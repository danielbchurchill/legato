import { beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "../sqlite.js";
import { openDb } from "../db.js";
import { mergeDuplicatePeople, mergeNodeInto } from "./people.js";

let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
});

function makeNode(type: string, title: string): number {
  return (db.prepare("INSERT INTO nodes (type, title) VALUES (?, ?) RETURNING id").get(type, title) as { id: number })
    .id;
}

function addEdge(from: number, to: number, type: string, source = "local", label: string | null = null): number {
  return (
    db
      .prepare("INSERT INTO edges (from_node, to_node, type, source, label) VALUES (?, ?, ?, ?, ?) RETURNING id")
      .get(from, to, type, source, label) as { id: number }
  ).id;
}

function edgesOf(nodeId: number): { from: number; to: number; type: string; source: string; label: string | null }[] {
  return db
    .prepare(
      `SELECT from_node AS "from", to_node AS "to", type, source, label FROM edges
        WHERE from_node = ? OR to_node = ? ORDER BY id`,
    )
    .all(nodeId, nodeId) as { from: number; to: number; type: string; source: string; label: string | null }[];
}

function search(term: string): { id: number; type: string }[] {
  return db
    .prepare(
      "SELECT n.id, n.type FROM nodes_fts f JOIN nodes n ON n.id = f.rowid WHERE nodes_fts MATCH ? ORDER BY n.id",
    )
    .all(term) as { id: number; type: string }[];
}

// Issue #273's own example, cut down: Bob Dylan is the artist on his tracks
// and, from MusicBrainz's relations, a credit node for producing and
// playing on them.
function dylanTwice() {
  const artist = makeNode("artist", "Bob Dylan");
  const credit = makeNode("credit", "bob dylan ");
  const track = makeNode("recording", "Like a Rolling Stone");
  addEdge(track, artist, "performed_by");
  addEdge(track, credit, "produced_by", "musicbrainz");
  addEdge(track, credit, "performed_credit", "musicbrainz", "vocals");
  addEdge(track, credit, "performed_credit", "musicbrainz", "harmonica");
  return { artist, credit, track };
}

describe("mergeDuplicatePeople", () => {
  it("makes an artist credited as a producer and performer one node, with every role kept", () => {
    const { artist, credit, track } = dylanTwice();

    expect(mergeDuplicatePeople(db)).toBe(1);

    expect(db.prepare("SELECT id FROM nodes WHERE id = ?").get(credit)).toBeUndefined();
    expect(edgesOf(artist).map((e) => [e.from, e.type, e.label])).toEqual([
      [track, "performed_by", null],
      [track, "produced_by", null],
      [track, "performed_credit", "vocals"],
      [track, "performed_credit", "harmonica"],
    ]);
    // Search reads nodes_fts, which the delete trigger keeps in step.
    expect(search("dylan")).toEqual([{ id: artist, type: "artist" }]);
  });

  it("keeps favourites, user-made connections and a dragged position from the credit node", () => {
    const { artist, credit } = dylanTwice();
    const friend = makeNode("artist", "Joan Baez");
    db.prepare("INSERT INTO favourites (node_id) VALUES (?)").run(credit);
    addEdge(credit, friend, "personal", "manual");
    db.prepare("INSERT INTO positions (node_id, granularity, seed_x, seed_y) VALUES (?, 'tracks', 1, 1)").run(artist);
    db.prepare(
      "INSERT INTO positions (node_id, granularity, seed_x, seed_y, user_x, user_y) VALUES (?, 'tracks', 9, 9, 40, 50)",
    ).run(credit);

    mergeDuplicatePeople(db);

    expect(db.prepare("SELECT node_id FROM favourites").all()).toEqual([{ node_id: artist }]);
    expect(edgesOf(friend)).toEqual([{ from: artist, to: friend, type: "personal", source: "manual", label: null }]);
    expect(db.prepare("SELECT node_id, seed_x, user_x, user_y FROM positions").all()).toEqual([
      { node_id: artist, seed_x: 1, user_x: 40, user_y: 50 },
    ]);
  });

  it("moves the credit's map position onto an artist that has none, so a merged producer stays on the map", () => {
    const { artist, credit } = dylanTwice();
    db.prepare("INSERT INTO positions (node_id, granularity, seed_x, seed_y) VALUES (?, 'tracks', 7, 8)").run(credit);

    mergeDuplicatePeople(db);

    expect(db.prepare("SELECT node_id, seed_x, seed_y FROM positions").all()).toEqual([
      { node_id: artist, seed_x: 7, seed_y: 8 },
    ]);
  });

  it("lets the artist's own favourite and dragged position win", () => {
    const { artist, credit } = dylanTwice();
    db.prepare("INSERT INTO favourites (node_id, created_at) VALUES (?, '2026-01-01')").run(artist);
    db.prepare("INSERT INTO favourites (node_id, created_at) VALUES (?, '2026-05-05')").run(credit);
    db.prepare(
      "INSERT INTO positions (node_id, granularity, seed_x, seed_y, user_x, user_y) VALUES (?, 'tracks', 1, 1, 2, 3)",
    ).run(artist);
    db.prepare(
      "INSERT INTO positions (node_id, granularity, seed_x, seed_y, user_x, user_y) VALUES (?, 'tracks', 9, 9, 40, 50)",
    ).run(credit);

    mergeDuplicatePeople(db);

    expect(db.prepare("SELECT node_id, created_at FROM favourites").all()).toEqual([
      { node_id: artist, created_at: "2026-01-01" },
    ]);
    expect(db.prepare("SELECT user_x, user_y FROM positions").all()).toEqual([{ user_x: 2, user_y: 3 }]);
  });

  it("drops an edge the merge doubles, keeping the user-made copy, and a connection between the two", () => {
    const artist = makeNode("artist", "Bob Dylan");
    const credit = makeNode("credit", "Bob Dylan");
    const other = makeNode("artist", "The Band");
    addEdge(artist, other, "personal");
    addEdge(credit, other, "personal", "manual");
    addEdge(artist, credit, "personal", "manual");

    mergeDuplicatePeople(db);

    expect(edgesOf(artist)).toEqual([{ from: artist, to: other, type: "personal", source: "manual", label: null }]);
  });

  // Every column that references nodes(id) is found from the schema, so
  // tables nobody listed by hand move too.
  it("moves rows in every table that points at the credit node", () => {
    const { artist, credit } = dylanTwice();
    db.prepare(
      "INSERT INTO field_provenance (node_id, field, value, source) VALUES (?, 'artist_mbid', 'mb-dylan', 'musicbrainz')",
    ).run(credit);
    db.prepare("INSERT INTO articles (node_id, body_md) VALUES (?, 'Produced 1 track.')").run(credit);
    db.prepare("INSERT INTO node_similarity_features (node_id, vector_json) VALUES (?, '[]')").run(credit);

    mergeDuplicatePeople(db);

    expect(db.prepare("SELECT node_id FROM field_provenance").all()).toEqual([{ node_id: artist }]);
    expect(db.prepare("SELECT node_id FROM articles").all()).toEqual([{ node_id: artist }]);
    expect(db.prepare("SELECT node_id FROM node_similarity_features").all()).toEqual([{ node_id: artist }]);
  });

  // A done lookup moved onto the artist would stop the artist's own being
  // queued.
  it("drops the credit node's enrichment jobs instead of moving them", () => {
    const { credit } = dylanTwice();
    db.prepare("INSERT INTO enrich_jobs (node_id, job_type, status) VALUES (?, 'description_lookup', 'done')").run(
      credit,
    );

    mergeDuplicatePeople(db);

    expect(db.prepare("SELECT COUNT(*) AS n FROM enrich_jobs").get()).toEqual({ n: 0 });
  });

  it("merges into the oldest artist when two share the name, and leaves the artists apart", () => {
    const older = makeNode("artist", "Bob Dylan");
    const newer = makeNode("artist", "BOB DYLAN");
    const credit = makeNode("credit", "Bob Dylan");
    const track = makeNode("recording", "Song");
    addEdge(track, credit, "produced_by");

    expect(mergeDuplicatePeople(db)).toBe(1);

    expect(edgesOf(older).map((e) => e.type)).toEqual(["produced_by"]);
    expect(db.prepare("SELECT id FROM nodes WHERE type = 'artist' ORDER BY id").all()).toEqual([
      { id: older },
      { id: newer },
    ]);
  });

  it("leaves a credit with no artist of that name, and does nothing when there's nothing to merge", () => {
    const credit = makeNode("credit", "Bob Johnston");
    makeNode("artist", "Bob Dylan");

    expect(mergeDuplicatePeople(db)).toBe(0);
    expect(db.prepare("SELECT type FROM nodes WHERE id = ?").get(credit)).toEqual({ type: "credit" });
  });
});

describe("mergeNodeInto", () => {
  it("is a no-op for a node merged into itself", () => {
    const artist = makeNode("artist", "Bob Dylan");
    mergeNodeInto(db, artist, artist);
    expect(db.prepare("SELECT id FROM nodes").all()).toEqual([{ id: artist }]);
  });
});
