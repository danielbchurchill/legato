import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "../sqlite.js";
import { openDb } from "../db.js";
import { applyMemberRelations, pruneBeyondMemberBound } from "./members.js";
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

// Issue #269.
describe("pruneBeyondMemberBound", () => {
  function recordingWith(type: string, artistId: number): number {
    const recording = makeNode("recording", "A track");
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, ?, 'local')").run(
      recording,
      artistId,
      type,
    );
    return recording;
  }

  function memberOf(member: number, group: number): void {
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'member_of', 'musicbrainz')").run(
      member,
      group,
    );
  }

  // Everything the unbounded crawl wrote for an artist it reached.
  function crawled(title: string): number {
    const id = makeNode("artist", title);
    for (const job of ["artist_member_lookup", "artist_image_lookup", "description_lookup"]) {
      db.prepare("INSERT INTO enrich_jobs (node_id, job_type, status) VALUES (?, ?, 'done')").run(id, job);
    }
    db.prepare(
      "INSERT INTO field_provenance (node_id, field, value, source, confidence) VALUES (?, 'artist_mbid', 'x', 'musicbrainz', 0.8)",
    ).run(id);
    db.prepare("INSERT INTO descriptions (node_id, body, source) VALUES (?, 'About them.', 'wikipedia')").run(id);
    db.prepare("INSERT INTO cover_art (node_id, source, hash) VALUES (?, 'artist_image', ?)").run(id, `photo-${id}`);
    db.prepare("INSERT INTO positions (node_id, granularity, seed_x, seed_y) VALUES (?, 'tracks', 0, 0)").run(id);
    return id;
  }

  function artistTitles(): string[] {
    return (
      db.prepare("SELECT title FROM nodes WHERE type = 'artist' ORDER BY title").all() as { title: string }[]
    ).map((r) => r.title);
  }

  function jobsFor(nodeId: number): string[] {
    return (
      db.prepare("SELECT job_type FROM enrich_jobs WHERE node_id = ? ORDER BY job_type").all(nodeId) as {
        job_type: string;
      }[]
    ).map((r) => r.job_type);
  }

  let beatles: number;
  let george: number;
  let wilburys: number;
  let martin: number;
  let dylan: number;

  beforeEach(() => {
    beatles = crawled("The Beatles");
    recordingWith("performed_by", beatles);
    // A producer in the library (#280), whose own lookup ran before the bound.
    martin = crawled("George Martin");
    recordingWith("produced_by", martin);
    george = crawled("George Harrison");
    wilburys = crawled("Traveling Wilburys");
    dylan = crawled("Bob Dylan");
    const theBand = crawled("The Band");
    const martinsGroup = crawled("The George Martin Orchestra");
    memberOf(george, beatles);
    memberOf(george, wilburys);
    memberOf(dylan, wilburys);
    memberOf(dylan, theBand);
    memberOf(martin, martinsGroup);
  });

  it("keeps the library, its members and groups, and their groups, and deletes the rest with everything it left", () => {
    const pruned = pruneBeyondMemberBound(db);

    expect(artistTitles()).toEqual(["George Harrison", "George Martin", "The Beatles", "Traveling Wilburys"]);
    expect(memberOfEdges()).toEqual([
      { member: "George Harrison", group_title: "The Beatles", source: "musicbrainz" },
      { member: "George Harrison", group_title: "Traveling Wilburys", source: "musicbrainz" },
    ]);
    expect(pruned).toMatchObject({ artists: 3, memberEdges: 3 });

    // Rows that pointed at a deleted artist went with it.
    expect(jobsFor(dylan)).toEqual([]);
    for (const table of ["field_provenance", "descriptions", "cover_art", "positions"]) {
      expect(db.prepare(`SELECT node_id FROM ${table} WHERE node_id = ?`).all(dylan)).toEqual([]);
    }
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("drops the done member lookups of artists that no longer get one, so they're asked again if that changes", () => {
    pruneBeyondMemberBound(db);

    const everyLookup = ["artist_image_lookup", "artist_member_lookup", "description_lookup"];
    expect(jobsFor(beatles)).toEqual(everyLookup);
    expect(jobsFor(george)).toEqual(everyLookup);
    expect(jobsFor(wilburys)).toEqual(["artist_image_lookup", "description_lookup"]);
    expect(jobsFor(martin)).toEqual(["artist_image_lookup", "description_lookup"]);
  });

  it("keeps an artist past the bound that carries user data, from any table that isn't enrichment's own", () => {
    const favourite = crawled("Tom Petty");
    const connected = crawled("Roy Orbison");
    const dragged = crawled("Jeff Lynne");
    const listed = crawled("Bev Bevan");
    for (const id of [favourite, connected, dragged, listed]) memberOf(id, wilburys);
    db.prepare("INSERT INTO favourites (node_id) VALUES (?)").run(favourite);
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'sounds_like', 'manual')").run(
      beatles,
      connected,
    );
    db.prepare("UPDATE positions SET user_x = 10, user_y = 20 WHERE node_id = ?").run(dragged);
    const playlist = db.prepare("INSERT INTO playlists (name) VALUES ('Wilburys') RETURNING id").get() as {
      id: number;
    };
    db.prepare("INSERT INTO playlist_tracks (playlist_id, node_id, position) VALUES (?, ?, 0)").run(
      playlist.id,
      listed,
    );

    pruneBeyondMemberBound(db);

    expect(artistTitles()).toEqual([
      "Bev Bevan",
      "George Harrison",
      "George Martin",
      "Jeff Lynne",
      "Roy Orbison",
      "The Beatles",
      "Tom Petty",
      "Traveling Wilburys",
    ]);
    expect(db.prepare("SELECT node_id FROM favourites").all()).toEqual([{ node_id: favourite }]);
    expect(db.prepare("SELECT to_node FROM edges WHERE source = 'manual'").all()).toEqual([{ to_node: connected }]);
    expect(db.prepare("SELECT user_x FROM positions WHERE node_id = ?").get(dragged)).toEqual({ user_x: 10 });
    // Kept, but no longer linked to the Wilburys: that edge is past the bound.
    expect(db.prepare("SELECT id FROM edges WHERE type = 'member_of' AND from_node = ?").all(favourite)).toEqual([]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("counts an artist with any edge from a recording as the library's, and a manual member_of edge as user data", () => {
    const engineer = crawled("Geoff Emerick");
    recordingWith("engineered_by", engineer);
    const manualGroup = crawled("The Manual Band");
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'member_of', 'manual')").run(
      dylan,
      manualGroup,
    );

    pruneBeyondMemberBound(db);

    const artists = artistTitles();
    expect(artists).toContain("Geoff Emerick");
    expect(artists).toContain("Bob Dylan");
    expect(artists).toContain("The Manual Band");
    expect(artists).not.toContain("The Band");
  });

  it("finds nothing to do on a database already inside the bound", () => {
    pruneBeyondMemberBound(db);

    expect(pruneBeyondMemberBound(db)).toEqual({ artists: 0, memberEdges: 0, jobs: 0, reclaimedBytes: 0 });
  });

  it("leaves foreign keys on afterwards", () => {
    pruneBeyondMemberBound(db);

    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  });

  it("reclaims the space on disk once most of the file is free", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "legato-prune-"));
    try {
      const file = path.join(dir, "legato.db");
      const onDisk = openDb(file, { log: () => {} });
      const library = onDisk
        .prepare("INSERT INTO nodes (type, title) VALUES ('artist', 'The Beatles') RETURNING id")
        .get() as {
        id: number;
      };
      const recording = onDisk
        .prepare("INSERT INTO nodes (type, title) VALUES ('recording', 'x') RETURNING id")
        .get() as {
        id: number;
      };
      onDisk
        .prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'performed_by', 'local')")
        .run(recording.id, library.id);
      onDisk.transaction(() => {
        for (let i = 0; i < 2000; i++) {
          const id = (
            onDisk.prepare("INSERT INTO nodes (type, title) VALUES ('artist', ?) RETURNING id").get(`Far ${i}`) as {
              id: number;
            }
          ).id;
          onDisk
            .prepare("INSERT INTO descriptions (node_id, body, source) VALUES (?, ?, 'wikipedia')")
            .run(id, "x".repeat(2000));
        }
      })();
      onDisk.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      const before = statSync(file).size;

      const pruned = pruneBeyondMemberBound(onDisk);

      expect(pruned.artists).toBe(2000);
      expect(pruned.reclaimedBytes).toBeGreaterThan(0);
      expect(statSync(file).size).toBeLessThan(before / 4);
      onDisk.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
