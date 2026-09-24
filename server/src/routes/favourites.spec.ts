import { beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "../sqlite.js";
import { openDb } from "../db.js";
import { addFavourite, listFavourites, removeFavourite } from "./favourites.js";

let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
});

function makeNode(type: string, title: string): number {
  const row = db.prepare("INSERT INTO nodes (type, title) VALUES (?, ?) RETURNING id").get(type, title) as {
    id: number;
  };
  return row.id;
}

describe("favourites", () => {
  it("favourites a node, lists it, then unfavourites it", () => {
    const nodeId = makeNode("recording", "Visions of Johanna");

    addFavourite(db, nodeId);
    expect(listFavourites(db)).toEqual([{ id: nodeId, type: "recording", title: "Visions of Johanna" }]);

    removeFavourite(db, nodeId);
    expect(listFavourites(db)).toEqual([]);
  });

  it("is idempotent — favouriting an already-favourited node doesn't error or duplicate", () => {
    const nodeId = makeNode("artist", "Bob Dylan");

    addFavourite(db, nodeId);
    expect(() => addFavourite(db, nodeId)).not.toThrow();
    expect(listFavourites(db)).toHaveLength(1);
  });

  it("orders most-recently-favourited first", () => {
    const first = makeNode("recording", "First");
    const second = makeNode("recording", "Second");

    // created_at defaults to datetime('now'), which only has second
    // resolution — back-date the first row so the ordering assertion
    // doesn't depend on the two inserts landing in the same wall-clock
    // second.
    db.prepare("INSERT INTO favourites (node_id, created_at) VALUES (?, datetime('now', '-1 minute'))").run(first);
    addFavourite(db, second);

    expect(listFavourites(db).map((f) => f.id)).toEqual([second, first]);
  });

  it("unfavouriting a node that was never favourited is a no-op", () => {
    const nodeId = makeNode("release", "Blood on the Tracks");
    expect(() => removeFavourite(db, nodeId)).not.toThrow();
    expect(listFavourites(db)).toEqual([]);
  });
});
