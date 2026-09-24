import { beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "../sqlite.js";
import { openDb } from "../db.js";
import { applyMemberRelations } from "./members.js";
import type { MbArtistRelation } from "./mbClient.js";

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

function memberOfEdges() {
  return db
    .prepare(
      `SELECT fn.title AS member, tn.title AS group_title, e.source
       FROM edges e
       JOIN nodes fn ON fn.id = e.from_node
       JOIN nodes tn ON tn.id = e.to_node
       WHERE e.type = 'member_of'
       ORDER BY fn.title, tn.title`,
    )
    .all() as { member: string; group_title: string; source: string }[];
}

describe("applyMemberRelations — issue #61", () => {
  it("a backward relation (queried from the group's own page) writes member -> group", () => {
    const beatles = makeNode("artist", "The Beatles");
    const relations: MbArtistRelation[] = [
      { direction: "backward", name: "George Harrison" },
      { direction: "backward", name: "Paul McCartney" },
    ];

    applyMemberRelations(db, beatles, relations);

    expect(memberOfEdges()).toEqual([
      { member: "George Harrison", group_title: "The Beatles", source: "musicbrainz" },
      { member: "Paul McCartney", group_title: "The Beatles", source: "musicbrainz" },
    ]);
  });

  it("a forward relation (queried from the member's own page) writes this artist -> group", () => {
    const george = makeNode("artist", "George Harrison");
    const relations: MbArtistRelation[] = [
      { direction: "forward", name: "The Beatles" },
      { direction: "forward", name: "The Traveling Wilburys" },
    ];

    applyMemberRelations(db, george, relations);

    expect(memberOfEdges()).toEqual([
      { member: "George Harrison", group_title: "The Beatles", source: "musicbrainz" },
      { member: "George Harrison", group_title: "The Traveling Wilburys", source: "musicbrainz" },
    ]);
  });

  it("creates a stub artist node for a member not yet in the library, and reports it as new", () => {
    const beatles = makeNode("artist", "The Beatles");

    const newIds = applyMemberRelations(db, beatles, [{ direction: "backward", name: "George Harrison" }]);

    expect(newIds).toHaveLength(1);
    const created = db.prepare("SELECT type, title FROM nodes WHERE id = ?").get(newIds[0]);
    expect(created).toEqual({ type: "artist", title: "George Harrison" });
  });

  it("collapses onto an existing artist node case/whitespace-insensitively instead of creating a duplicate", () => {
    const beatles = makeNode("artist", "The Beatles");
    makeNode("artist", " george harrison ");

    const newIds = applyMemberRelations(db, beatles, [{ direction: "backward", name: "George Harrison" }]);

    expect(newIds).toEqual([]);
    const artistNodes = db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE type = 'artist'").get() as { n: number };
    expect(artistNodes.n).toBe(2); // Beatles + the pre-existing George Harrison, no third
  });

  it("re-running with a smaller relation set drops the edge that fell out, not just adds", () => {
    const george = makeNode("artist", "George Harrison");
    applyMemberRelations(db, george, [
      { direction: "forward", name: "The Beatles" },
      { direction: "forward", name: "The Traveling Wilburys" },
    ]);

    applyMemberRelations(db, george, [{ direction: "forward", name: "The Beatles" }]);

    expect(memberOfEdges()).toEqual([{ member: "George Harrison", group_title: "The Beatles", source: "musicbrainz" }]);
  });

  it("re-running from the group's side doesn't touch a member's own separately-established edges to another group", () => {
    const beatles = makeNode("artist", "The Beatles");
    const george = makeNode("artist", "George Harrison");
    applyMemberRelations(db, george, [{ direction: "forward", name: "The Traveling Wilburys" }]);

    applyMemberRelations(db, beatles, [{ direction: "backward", name: "George Harrison" }]);

    expect(memberOfEdges()).toEqual([
      { member: "George Harrison", group_title: "The Beatles", source: "musicbrainz" },
      { member: "George Harrison", group_title: "The Traveling Wilburys", source: "musicbrainz" },
    ]);
  });

  it("dedupes an exact duplicate relation MusicBrainz's own data sometimes carries", () => {
    const beatles = makeNode("artist", "The Beatles");

    applyMemberRelations(db, beatles, [
      { direction: "backward", name: "George Harrison" },
      { direction: "backward", name: "George Harrison" },
    ]);

    expect(memberOfEdges()).toEqual([{ member: "George Harrison", group_title: "The Beatles", source: "musicbrainz" }]);
  });

  it("never writes a self-edge if MusicBrainz's data names the queried artist itself", () => {
    const beatles = makeNode("artist", "The Beatles");

    applyMemberRelations(db, beatles, [{ direction: "backward", name: "The Beatles" }]);

    expect(memberOfEdges()).toEqual([]);
  });

  it("clearing every relation on a re-run removes previously-written edges", () => {
    const beatles = makeNode("artist", "The Beatles");
    applyMemberRelations(db, beatles, [{ direction: "backward", name: "George Harrison" }]);

    applyMemberRelations(db, beatles, []);

    expect(memberOfEdges()).toEqual([]);
  });

  it("leaves a manual member_of edge on a different node pair untouched", () => {
    const beatles = makeNode("artist", "The Beatles");
    const wilburys = makeNode("artist", "The Traveling Wilburys");
    const george = makeNode("artist", "George Harrison");
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'member_of', 'manual')").run(
      george,
      wilburys,
    );

    applyMemberRelations(db, beatles, [{ direction: "backward", name: "George Harrison" }]);

    const edges = db
      .prepare(
        `SELECT fn.title AS member, tn.title AS group_title, e.source
         FROM edges e JOIN nodes fn ON fn.id = e.from_node JOIN nodes tn ON tn.id = e.to_node
         WHERE e.type = 'member_of' ORDER BY e.source`,
      )
      .all() as { member: string; group_title: string; source: string }[];
    expect(edges).toContainEqual({ member: "George Harrison", group_title: "The Traveling Wilburys", source: "manual" });
    expect(edges).toContainEqual({ member: "George Harrison", group_title: "The Beatles", source: "musicbrainz" });
  });
});
