import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "../db.js";
import { applyCredits, recordIsrc, recordReleaseFields } from "./credits.js";
import type { MbCredit, MbReleaseDetail } from "./mbClient.js";

let db: Database.Database;

beforeEach(() => {
  db = openDb(":memory:");
});

function makeNode(type: string, title: string): number {
  const row = db.prepare("INSERT INTO nodes (type, title) VALUES (?, ?) RETURNING id").get(type, title) as {
    id: number;
  };
  return row.id;
}

function edgesFrom(nodeId: number) {
  return db
    .prepare(
      `SELECT e.type, e.source, e.label, n.title AS other_title
       FROM edges e JOIN nodes n ON n.id = e.to_node
       WHERE e.from_node = ?
       ORDER BY e.type, n.title`,
    )
    .all(nodeId) as { type: string; source: string; label: string | null; other_title: string }[];
}

function releaseDetail(overrides: Partial<MbReleaseDetail> = {}): MbReleaseDetail {
  return {
    mbid: "release-1",
    status: null,
    country: null,
    barcode: null,
    asin: null,
    disambiguation: null,
    language: null,
    script: null,
    format: null,
    releaseGroupMbid: null,
    firstReleaseDate: null,
    labelName: null,
    catalogNumber: null,
    tracks: [],
    ...overrides,
  };
}

describe("applyCredits", () => {
  it("maps role relations to their edge type, sourced musicbrainz", () => {
    const recording = makeNode("recording", "Come Together");
    const credits: MbCredit[] = [
      { type: "producer", artistName: "George Martin", attributes: [] },
      { type: "engineer", artistName: "Geoff Emerick", attributes: [] },
      { type: "mix", artistName: "Giles Martin", attributes: [] },
    ];

    applyCredits(db, recording, credits);

    const edges = edgesFrom(recording);
    expect(edges).toContainEqual({ type: "produced_by", source: "musicbrainz", label: null, other_title: "George Martin" });
    expect(edges).toContainEqual({ type: "engineered_by", source: "musicbrainz", label: null, other_title: "Geoff Emerick" });
    expect(edges).toContainEqual({ type: "mixed_by", source: "musicbrainz", label: null, other_title: "Giles Martin" });
  });

  it("gives vocal/instrument/performer relations one shared edge type with the part as the label", () => {
    const recording = makeNode("recording", "Come Together");
    const credits: MbCredit[] = [
      { type: "instrument", artistName: "George Harrison", attributes: ["electric guitar"] },
      { type: "vocal", artistName: "John Lennon", attributes: ["lead vocals"] },
    ];

    applyCredits(db, recording, credits);

    const edges = edgesFrom(recording);
    expect(edges).toContainEqual({
      type: "performed_credit",
      source: "musicbrainz",
      label: "electric guitar",
      other_title: "George Harrison",
    });
    expect(edges).toContainEqual({
      type: "performed_credit",
      source: "musicbrainz",
      label: "lead vocals",
      other_title: "John Lennon",
    });
  });

  it("falls back to the relation type itself as the label when no attribute is given", () => {
    const recording = makeNode("recording", "Come Together");
    applyCredits(db, recording, [{ type: "performer", artistName: "Billy Preston", attributes: [] }]);

    expect(edgesFrom(recording)).toContainEqual({
      type: "performed_credit",
      source: "musicbrainz",
      label: "performer",
      other_title: "Billy Preston",
    });
  });

  it("silently skips a relation type this product has no mapping for, rather than crashing", () => {
    const recording = makeNode("recording", "Come Together");
    applyCredits(db, recording, [{ type: "some future MB relation type", artistName: "Nobody", attributes: [] }]);

    expect(edgesFrom(recording)).toEqual([]);
  });

  it("reuses an existing credit node by name (case/whitespace-insensitive) rather than duplicating it", () => {
    const existing = makeNode("credit", " George Martin ");
    const recording = makeNode("recording", "Come Together");

    applyCredits(db, recording, [{ type: "producer", artistName: "george martin", attributes: [] }]);

    const edge = edgesFrom(recording)[0];
    const creditNode = db.prepare("SELECT id FROM nodes WHERE type = 'credit'").all() as { id: number }[];
    expect(creditNode).toHaveLength(1); // no duplicate node created
    expect(edge.other_title).toBe(" George Martin "); // the pre-existing node's own title, unchanged
    expect(existing).toBe(creditNode[0].id);
  });

  it("re-derives from scratch — a second call never accumulates duplicate edges from the first", () => {
    const recording = makeNode("recording", "Come Together");
    applyCredits(db, recording, [
      { type: "producer", artistName: "George Martin", attributes: [] },
      { type: "engineer", artistName: "Geoff Emerick", attributes: [] },
    ]);
    applyCredits(db, recording, [{ type: "producer", artistName: "George Martin", attributes: [] }]);

    const edges = edgesFrom(recording);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ type: "produced_by", other_title: "George Martin" });
  });

  it("dedupes exact-duplicate relations within one call — confirmed live, MusicBrainz's own data isn't always deduped", () => {
    const recording = makeNode("recording", "A Taste of Honey");
    applyCredits(db, recording, [
      { type: "producer", artistName: "George Martin", attributes: [] },
      { type: "producer", artistName: "George Martin", attributes: [] },
      { type: "instrument", artistName: "George Harrison", attributes: ["electric guitar"] },
      { type: "instrument", artistName: "George Harrison", attributes: ["electric guitar"] },
    ]);

    const edges = edgesFrom(recording);
    expect(edges.filter((e) => e.type === "produced_by")).toHaveLength(1);
    expect(edges.filter((e) => e.type === "performed_credit")).toHaveLength(1);
  });

  it("keeps two relations for the same person distinct when their attributes differ", () => {
    const recording = makeNode("recording", "Come Together");
    applyCredits(db, recording, [
      { type: "vocal", artistName: "Paul McCartney", attributes: ["lead vocals"] },
      { type: "vocal", artistName: "Paul McCartney", attributes: ["background vocals"] },
    ]);

    const edges = edgesFrom(recording).filter((e) => e.type === "performed_credit");
    expect(edges).toHaveLength(2);
    expect(edges.map((e) => e.label).sort()).toEqual(["background vocals", "lead vocals"]);
  });

  it("never touches a recording's source='local' edges", () => {
    const recording = makeNode("recording", "Come Together");
    const artist = makeNode("artist", "The Beatles");
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'performed_by', 'local')").run(
      recording,
      artist,
    );

    applyCredits(db, recording, [{ type: "producer", artistName: "George Martin", attributes: [] }]);

    const edges = edgesFrom(recording);
    expect(edges).toContainEqual(expect.objectContaining({ type: "performed_by", source: "local" }));
    expect(edges).toContainEqual(expect.objectContaining({ type: "produced_by", source: "musicbrainz" }));
  });
});

function provenanceFor(nodeId: number) {
  return db
    .prepare("SELECT field, value, source, confidence FROM field_provenance WHERE node_id = ? ORDER BY field")
    .all(nodeId) as { field: string; value: string; source: string; confidence: number }[];
}

describe("recordReleaseFields", () => {
  it("writes one field_provenance row per non-null field", () => {
    const release = makeNode("release", "Abbey Road");
    recordReleaseFields(
      db,
      release,
      releaseDetail({
        mbid: "9e53c190-5621-3848-8ae4-39ad9f7d9ace",
        status: "Official",
        country: "GB",
        barcode: "077774644624",
        format: "CD",
        labelName: "Parlophone",
        catalogNumber: "CDP 7 46446 2",
      }),
    );

    const rows = provenanceFor(release);
    expect(rows).toContainEqual({ field: "status", value: "Official", source: "musicbrainz", confidence: 1 });
    expect(rows).toContainEqual({ field: "country", value: "GB", source: "musicbrainz", confidence: 1 });
    expect(rows).toContainEqual({ field: "label_name", value: "Parlophone", source: "musicbrainz", confidence: 1 });
    // Null fields (asin, disambiguation, ...) never got a row at all.
    expect(rows.some((r) => r.field === "asin")).toBe(false);
  });
});

describe("recordIsrc", () => {
  it("writes a field_provenance row when an ISRC is present", () => {
    const recording = makeNode("recording", "Come Together");
    recordIsrc(db, recording, "GBAYE0000944");
    expect(provenanceFor(recording)).toEqual([
      { field: "isrc", value: "GBAYE0000944", source: "musicbrainz", confidence: 1 },
    ]);
  });

  it("writes nothing when there is no ISRC", () => {
    const recording = makeNode("recording", "Come Together");
    recordIsrc(db, recording, null);
    expect(provenanceFor(recording)).toEqual([]);
  });
});
