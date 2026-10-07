import { beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "./sqlite.js";
import { openDb } from "./db.js";
import { nodeCredits } from "./nodeCredits.js";

let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
});

function makeNode(type: string, title: string): number {
  return (db.prepare("INSERT INTO nodes (type, title) VALUES (?, ?) RETURNING id").get(type, title) as { id: number })
    .id;
}

function addEdge(from: number, to: number, type: string, source = "local"): void {
  db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, ?, ?)").run(from, to, type, source);
}

// Highway 61 Revisited, cut down: two tracks, the artist on both, a
// producer on both, and a performer credit on one. Performer credits get
// no map position, which is what used to turn this one into "?".
function highway61() {
  const dylan = makeNode("artist", "Bob Dylan");
  const album = makeNode("release", "Highway 61 Revisited");
  const rolling = makeNode("recording", "Like a Rolling Stone");
  const tombstone = makeNode("recording", "Tombstone Blues");
  const johnston = makeNode("credit", "Bob Johnston");
  const bloomfield = makeNode("credit", "Mike Bloomfield");
  for (const track of [rolling, tombstone]) {
    addEdge(track, album, "appears_on");
    addEdge(track, dylan, "performed_by");
    addEdge(track, johnston, "produced_by", "musicbrainz");
  }
  addEdge(tombstone, bloomfield, "performed_credit", "musicbrainz");
  return { dylan, album, rolling, tombstone, johnston, bloomfield };
}

describe("nodeCredits", () => {
  it("returns null for a node that doesn't exist, so the route can 404", () => {
    expect(nodeCredits(db, 999)).toBeNull();
  });

  it("names everyone credited on a record's tracks, map position or not, most-credited first", () => {
    const { album, rolling, tombstone, dylan, johnston, bloomfield } = highway61();

    expect(nodeCredits(db, album)).toEqual({
      tracks: [rolling, tombstone],
      people: [
        { id: johnston, title: "Bob Johnston", type: "credit", role: "producer", count: 2 },
        { id: dylan, title: "Bob Dylan", type: "artist", role: "artist", count: 2 },
        { id: bloomfield, title: "Mike Bloomfield", type: "credit", role: "performer", count: 1 },
      ],
    });
  });

  it("lists an artist's collaborators but not the artist itself", () => {
    const { dylan, johnston, bloomfield } = highway61();

    const people = nodeCredits(db, dylan)!.people.map((p) => p.id);

    expect(people).toEqual([johnston, bloomfield]);
  });

  it("keeps one row per role when a person holds two on the same tracks", () => {
    const track = makeNode("recording", "Song");
    const person = makeNode("credit", "Jon Brion");
    addEdge(track, person, "produced_by");
    addEdge(track, person, "mixed_by");

    expect(nodeCredits(db, track)!.people.map((p) => p.role)).toEqual(["producer", "mixing"]);
  });

  it("has no tracks or credits for a node type that isn't made of recordings", () => {
    expect(nodeCredits(db, makeNode("label", "Columbia"))).toEqual({ tracks: [], people: [] });
  });
});
