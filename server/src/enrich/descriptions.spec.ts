import type { Database } from "../sqlite.js";
import { beforeEach, describe, expect, it } from "bun:test";
import { openDb } from "../db.js";
import { getDescription, recordDescription } from "./descriptions.js";
import { WIKIPEDIA_LICENSE } from "./wikipedia.js";

let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
});

function insertArtist(title = "Genesis Owusu"): number {
  return (
    db.prepare("INSERT INTO nodes (type, title) VALUES ('artist', ?) RETURNING id").get(title) as { id: number }
  ).id;
}

const FOUND = {
  body: "Genesis Owusu is a Ghanaian-Australian musician.",
  sourceUrl: "https://en.wikipedia.org/wiki/Genesis_Owusu",
  license: WIKIPEDIA_LICENSE,
};

describe("descriptions", () => {
  it("returns null for a node nothing has looked up", () => {
    expect(getDescription(db, insertArtist())).toBeNull();
  });

  it("round-trips a found description with its attribution", () => {
    const nodeId = insertArtist();
    recordDescription(db, nodeId, "wikipedia", FOUND);

    const stored = getDescription(db, nodeId);
    expect(stored?.body).toBe(FOUND.body);
    expect(stored?.source).toBe("wikipedia");
    expect(stored?.source_url).toBe(FOUND.sourceUrl);
    expect(stored?.license).toBe(WIKIPEDIA_LICENSE);
  });

  // The negative cache: the row exists so the queue never asks again, but
  // there is nothing for the UI to render, so getDescription must not hand
  // back an empty section.
  it("records a miss as a row that reads back as nothing", () => {
    const nodeId = insertArtist();
    recordDescription(db, nodeId, "wikipedia", null);

    expect(getDescription(db, nodeId)).toBeNull();
    const row = db.prepare("SELECT found, body FROM descriptions WHERE node_id = ?").get(nodeId) as {
      found: number;
      body: string | null;
    };
    expect(row.found).toBe(0);
    expect(row.body).toBeNull();
  });

  it("replaces an earlier result rather than accumulating rows", () => {
    const nodeId = insertArtist();
    recordDescription(db, nodeId, "wikipedia", null);
    recordDescription(db, nodeId, "wikipedia", FOUND);

    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM descriptions WHERE node_id = ?").get(nodeId) as { n: number }).n,
    ).toBe(1);
    expect(getDescription(db, nodeId)?.body).toBe(FOUND.body);
  });

  it("lets a found description be superseded by a later miss", () => {
    const nodeId = insertArtist();
    recordDescription(db, nodeId, "wikipedia", FOUND);
    recordDescription(db, nodeId, "wikipedia", null);

    expect(getDescription(db, nodeId)).toBeNull();
  });
});
