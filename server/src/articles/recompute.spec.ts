import { describe, expect, it } from "bun:test";
import type { Database } from "../sqlite.js";
import { openDb } from "../db.js";
import { recomputeArticles } from "./recompute.js";

function makeNode(db: Database, type: string, title: string): number {
  const row = db.prepare("INSERT INTO nodes (type, title) VALUES (?, ?) RETURNING id").get(type, title) as {
    id: number;
  };
  return row.id;
}

function edge(db: Database, from: number, to: number, type: string, label: string | null = null): void {
  db.prepare("INSERT INTO edges (from_node, to_node, type, source, label) VALUES (?, ?, ?, 'local', ?)").run(
    from,
    to,
    type,
    label,
  );
}

function articleFor(db: Database, nodeId: number): string | undefined {
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

  it("claims a collaboration only for a real, unlabeled collaborated_with tie", () => {
    const db = openDb(":memory:");
    const artist = makeNode(db, "artist", "The Beatles");
    const trackCount = makeNode(db, "recording", "Come Together");
    edge(db, trackCount, artist, "performed_by");

    const realCollaborator = makeNode(db, "artist", "Billy Preston");
    edge(db, artist, realCollaborator, "collaborated_with");

    // G-7 affinity tie (entities/collaboration.ts) — same label/era/credit,
    // never a shared recording. Its label column carries the reason, and
    // that's exactly what should keep it out of "Has collaborated with".
    const affinityOnly = makeNode(db, "artist", "Never Actually Met");
    edge(db, artist, affinityOnly, "collaborated_with", "same_era");

    recomputeArticles(db);

    const body = articleFor(db, artist);
    expect(body).toContain(`Has collaborated with [Billy Preston](node:${realCollaborator})`);
    expect(body).not.toContain("Never Actually Met");
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

// Issue #281: every article is generated, but only one that came out
// different is written, outside any long transaction.
describe("recomputeArticles — writing only what changed", () => {
  it("leaves an unchanged article's row alone, rewrites a changed one and removes an emptied one", () => {
    const db = openDb(":memory:");
    const artist = makeNode(db, "artist", "The Beatles");
    const release = makeNode(db, "release", "Abbey Road");
    const credit = makeNode(db, "credit", "George Martin");
    const recording = makeNode(db, "recording", "Come Together");
    edge(db, recording, artist, "performed_by");
    edge(db, recording, release, "appears_on");
    edge(db, recording, credit, "produced_by");
    recomputeArticles(db);
    expect(articleFor(db, credit)).toBeDefined();
    db.prepare("UPDATE articles SET updated_at = '2000-01-01 00:00:00'").run();
    const stamp = (nodeId: number) =>
      (db.prepare("SELECT updated_at AS updatedAt FROM articles WHERE node_id = ?").get(nodeId) as { updatedAt: string } | undefined)
        ?.updatedAt;

    recomputeArticles(db);
    expect(stamp(recording)).toBe("2000-01-01 00:00:00");

    const other = makeNode(db, "recording", "Something");
    edge(db, other, release, "appears_on");
    db.prepare("DELETE FROM edges WHERE type = 'produced_by'").run();
    recomputeArticles(db);
    expect(stamp(recording)).not.toBe("2000-01-01 00:00:00");
    expect(articleFor(db, recording)).toContain("1 other track");
    expect(articleFor(db, credit)).toBeUndefined();
  });
});
