import { describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "../db.js";
import { recomputeArticles } from "./recompute.js";

function makeNode(db: Database.Database, type: string, title: string): number {
  const row = db.prepare("INSERT INTO nodes (type, title) VALUES (?, ?) RETURNING id").get(type, title) as {
    id: number;
  };
  return row.id;
}

function edge(db: Database.Database, from: number, to: number, type: string): void {
  db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, ?, 'local')").run(from, to, type);
}

function articleFor(db: Database.Database, nodeId: number): string | undefined {
  return (db.prepare("SELECT body_md FROM articles WHERE node_id = ?").get(nodeId) as { body_md: string } | undefined)
    ?.body_md;
}

describe("recomputeArticles", () => {
  it("writes a real article for a recording with real edges", () => {
    const db = openDb(":memory:");
    const artist = makeNode(db, "artist", "The Beatles");
    const release = makeNode(db, "release", "Abbey Road");
    const year = makeNode(db, "year", "1969");
    const label = makeNode(db, "label", "Apple Records");
    const credit = makeNode(db, "credit", "George Martin");
    const recording = makeNode(db, "recording", "Come Together");
    edge(db, recording, artist, "performed_by");
    edge(db, recording, release, "appears_on");
    edge(db, recording, year, "released_in");
    edge(db, recording, label, "released_on");
    edge(db, recording, credit, "produced_by");

    recomputeArticles(db);

    const body = articleFor(db, recording);
    expect(body).toContain("[The Beatles](node:" + artist + ")");
    expect(body).toContain("[Abbey Road](node:" + release + ")");
    expect(body).toContain("1969");
    expect(body).toContain("[Apple Records](node:" + label + ")");
    expect(body).toContain("[George Martin](node:" + credit + ")");
  });

  it("writes a credit article listing real recordings, realizing the vision doc's example", () => {
    const db = openDb(":memory:");
    const engineer = makeNode(db, "credit", "Geoff Emerick");
    const rec1 = makeNode(db, "recording", "Come Together");
    const rec2 = makeNode(db, "recording", "Something");
    edge(db, rec1, engineer, "engineered_by");
    edge(db, rec2, engineer, "engineered_by");

    recomputeArticles(db);

    const body = articleFor(db, engineer);
    expect(body).toContain("Engineered 2 recordings you own");
    expect(body).toContain(`[Come Together](node:${rec1})`);
    expect(body).toContain(`[Something](node:${rec2})`);
  });

  it("gives no article to a node with nothing to say, rather than an empty row", () => {
    const db = openDb(":memory:");
    const lonelyArtist = makeNode(db, "artist", "Nobody's Heard Of Them");

    recomputeArticles(db);

    expect(articleFor(db, lonelyArtist)).toBeUndefined();
  });

  it("removes a stale article when the underlying data no longer supports it", () => {
    const db = openDb(":memory:");
    const artist = makeNode(db, "artist", "The Beatles");
    const recording = makeNode(db, "recording", "Come Together");
    edge(db, recording, artist, "performed_by");

    recomputeArticles(db);
    expect(articleFor(db, recording)).toBeDefined();

    db.prepare("DELETE FROM edges WHERE from_node = ?").run(recording);
    recomputeArticles(db);
    expect(articleFor(db, recording)).toBeUndefined();
  });

  it("is idempotent — recomputing twice with no data change leaves one row", () => {
    const db = openDb(":memory:");
    const artist = makeNode(db, "artist", "The Beatles");
    const recording = makeNode(db, "recording", "Come Together");
    edge(db, recording, artist, "performed_by");

    recomputeArticles(db);
    recomputeArticles(db);

    const count = db.prepare("SELECT COUNT(*) AS n FROM articles").get() as { n: number };
    expect(count.n).toBe(1);
  });
});
