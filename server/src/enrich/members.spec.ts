import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "../sqlite.js";
import { openDb } from "../db.js";
import {
  applyMemberRelations,
  BOUND_HASH,
  ForeignKeysOffError,
  markBoundMayHaveShrunk,
  pruneBeyondMemberBound,
  pruneBeyondMemberBoundIfDue,
} from "./members.js";
import { applyCredits } from "./credits.js";
import { BOUND_SQL, withBound } from "./queue.js";
import { deriveLocalEdges } from "../match/edges.js";
import { recompute } from "../recompute.js";
import { edgesRoutes } from "../routes/edges.js";
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

function artistTitles(): string[] {
  return (db.prepare("SELECT title FROM nodes WHERE type = 'artist' ORDER BY title").all() as { title: string }[]).map(
    (r) => r.title,
  );
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

    expect(pruneBeyondMemberBound(db)).toEqual({ artists: 0, memberEdges: 0, jobs: 0 });
  });

  it("leaves foreign keys on afterwards", () => {
    pruneBeyondMemberBound(db);

    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  });

  // A library of one artist, and 2,000 crawled artists past the bound with
  // a long description each, so the prune frees most of the file.
  function crawlOnDisk(file: string): Database {
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
    return onDisk;
  }

  it("reclaims the space on disk once most of the file is free", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "legato-prune-"));
    let onDisk: Database | undefined;
    try {
      const file = path.join(dir, "legato.db");
      onDisk = crawlOnDisk(file);
      const before = statSync(file).size;

      const pruned = pruneBeyondMemberBoundIfDue(onDisk, () => {});

      expect(pruned?.artists).toBe(2000);
      expect(pruned?.reclaimedBytes).toBeGreaterThan(0);
      expect(statSync(file).size).toBeLessThan(before / 4);
    } finally {
      onDisk?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Issue #321: index.ts's call, on every start before the server listens.
  describe("on each start", () => {
    let logged: [string, string][];
    const log = (level: string, message: string) => logged.push([level, message]);

    beforeEach(() => {
      logged = [];
    });

    function pruneState(on: Database = db) {
      return on
        .prepare("SELECT bound_hash AS boundHash, bound_may_have_shrunk AS mayHaveShrunk FROM member_bound_prune")
        .get() as { boundHash: string | null; mayHaveShrunk: number };
    }

    // Every statement the database is given from here on.
    function recordStatements(): string[] {
      const statements: string[] = [];
      const prepare = db.prepare.bind(db);
      const exec = db.exec.bind(db);
      Object.assign(db, {
        prepare: (sql: string) => (statements.push(sql), prepare(sql)),
        exec: (sql: string) => (statements.push(sql), exec(sql)),
      });
      return statements;
    }

    function thrownBy(fn: () => unknown): unknown {
      try {
        fn();
      } catch (err) {
        return err;
      }
      throw new Error("expected a throw");
    }

    it("prunes a database never checked, logs what it removed, how long it took and why, and records the bound", () => {
      expect(pruneState()).toEqual({ boundHash: null, mayHaveShrunk: 0 });

      expect(pruneBeyondMemberBoundIfDue(db, log)).toMatchObject({ artists: 3, memberEdges: 3 });

      expect(artistTitles()).toEqual(["George Harrison", "George Martin", "The Beatles", "Traveling Wilburys"]);
      expect(logged).toHaveLength(1);
      expect(logged[0]![0]).toBe("info");
      expect(logged[0]![1]).toMatch(
        /^membership: removed 3 artist\(s\), 3 member_of edge\(s\) and \d+ enrichment job\(s\) past the membership bound in \d+\.\d s \(because this database hadn't been checked\)$/,
      );
      expect(pruneState()).toEqual({ boundHash: BOUND_HASH, mayHaveShrunk: 0 });
    });

    it("on a database with nothing past the bound, logs the check with its time and why it ran", () => {
      pruneBeyondMemberBound(db);

      expect(pruneBeyondMemberBoundIfDue(db, log)).toEqual({ artists: 0, memberEdges: 0, jobs: 0, reclaimedBytes: 0 });

      expect(logged).toHaveLength(1);
      expect(logged[0]![1]).toMatch(
        /^membership: nothing past the membership bound \(checked in \d+\.\d s, because this database hadn't been checked\)$/,
      );
      expect(pruneState()).toEqual({ boundHash: BOUND_HASH, mayHaveShrunk: 0 });
    });

    it("skips a start when nothing has changed since the last prune, reading one row and not the bound", () => {
      pruneBeyondMemberBoundIfDue(db, log);
      logged = [];
      // Past the bound, but nothing said the bound may have shrunk.
      makeNode("artist", "Far Away");
      const statements = recordStatements();

      expect(pruneBeyondMemberBoundIfDue(db, log)).toBeNull();

      expect(statements).toEqual(["SELECT bound_hash, bound_may_have_shrunk FROM member_bound_prune WHERE id = 1"]);
      expect(logged).toEqual([]);
      expect(artistTitles()).toContain("Far Away");
    });

    it("prunes again when the bound reads differently from the one the last prune read", () => {
      pruneBeyondMemberBoundIfDue(db, log);
      makeNode("artist", "Far Away");
      db.prepare("UPDATE member_bound_prune SET bound_hash = 'the hash of an older bound'").run();
      logged = [];

      expect(pruneBeyondMemberBoundIfDue(db, log)).toMatchObject({ artists: 1 });

      expect(artistTitles()).not.toContain("Far Away");
      expect(logged[0]![1]).toMatch(/\(because the bound's definition changed\)$/);
      expect(pruneState()).toEqual({ boundHash: BOUND_HASH, mayHaveShrunk: 0 });
    });

    it("prunes again when something may have shrunk the bound, and clears that", () => {
      pruneBeyondMemberBoundIfDue(db, log);
      makeNode("artist", "Far Away");
      markBoundMayHaveShrunk(db);
      logged = [];

      expect(pruneBeyondMemberBoundIfDue(db, log)).toMatchObject({ artists: 1 });

      expect(logged[0]![1]).toMatch(/\(because something removed since the last prune may have shrunk the bound\)$/);
      expect(pruneState()).toEqual({ boundHash: BOUND_HASH, mayHaveShrunk: 0 });
      expect(pruneBeyondMemberBoundIfDue(db, log)).toBeNull();
    });

    it("records a hash of exactly the statements withBound reads the bound with", () => {
      const statements = recordStatements();

      withBound(db, () => {});

      expect(statements.filter((sql) => BOUND_SQL.includes(sql))).toEqual([...BOUND_SQL]);
      expect(BOUND_HASH).toBe(createHash("sha256").update(BOUND_SQL.join("\n")).digest("hex"));
    });

    it("keeps its state out of settings, which any signed-in client can read and write", () => {
      pruneBeyondMemberBoundIfDue(db, log);
      markBoundMayHaveShrunk(db);

      expect(db.prepare("SELECT key FROM settings").all()).toEqual([]);
    });

    it("records nothing for a direct call: only the start's call does", () => {
      pruneBeyondMemberBound(db);

      expect(pruneState()).toEqual({ boundHash: null, mayHaveShrunk: 0 });
    });

    it("logs a failed prune, leaves the database as it was and unrecorded, and tries again next start", () => {
      const exec = db.exec.bind(db);
      Object.assign(db, {
        exec: (sql: string) => {
          if (sql.startsWith("DELETE FROM enrich_jobs")) throw new Error("disk I/O error");
          exec(sql);
        },
      });

      expect(pruneBeyondMemberBoundIfDue(db, log)).toBeNull();

      expect(logged).toEqual([["error", "membership: couldn't prune past the membership bound: disk I/O error"]]);
      expect(artistTitles()).toContain("Bob Dylan");
      expect(memberOfEdges()).toHaveLength(5);
      expect(pruneState()).toEqual({ boundHash: null, mayHaveShrunk: 0 });
      expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });

      Object.assign(db, { exec });
      expect(pruneBeyondMemberBoundIfDue(db, log)).toMatchObject({ artists: 3 });
      expect(pruneState()).toEqual({ boundHash: BOUND_HASH, mayHaveShrunk: 0 });
    });

    it("rolls the prune back if recording it fails, since that's the prune's own transaction", () => {
      const prepare = db.prepare.bind(db);
      Object.assign(db, {
        prepare: (sql: string) => {
          if (sql.includes("INSERT INTO member_bound_prune")) throw new Error("disk I/O error");
          return prepare(sql);
        },
      });

      expect(pruneBeyondMemberBoundIfDue(db, log)).toBeNull();

      expect(logged).toEqual([["error", "membership: couldn't prune past the membership bound: disk I/O error"]]);
      expect(artistTitles()).toContain("Bob Dylan");
      expect(memberOfEdges()).toHaveLength(5);
      expect(pruneState()).toEqual({ boundHash: null, mayHaveShrunk: 0 });
    });

    it("stops the start if foreign keys won't come back on after the prune committed, and says it committed", () => {
      const exec = db.exec.bind(db);
      Object.assign(db, {
        exec: (sql: string) => {
          if (sql === "PRAGMA foreign_keys = ON") throw new Error("out of memory");
          exec(sql);
        },
      });

      const err = thrownBy(() => pruneBeyondMemberBoundIfDue(db, log));

      expect(err).toBeInstanceOf(ForeignKeysOffError);
      expect((err as Error).message).toBe(
        "membership: couldn't turn foreign keys back on after the prune, which committed: out of memory",
      );
      expect(logged).toEqual([]);
      expect(artistTitles()).not.toContain("Bob Dylan");
      expect(pruneState().boundHash).toBe(BOUND_HASH);
    });

    it("stops the start if foreign keys won't come back on after a failed prune, and names that failure", () => {
      const exec = db.exec.bind(db);
      Object.assign(db, {
        exec: (sql: string) => {
          if (sql.startsWith("DELETE FROM enrich_jobs")) throw new Error("disk I/O error");
          if (sql === "PRAGMA foreign_keys = ON") return;
          exec(sql);
        },
      });

      const err = thrownBy(() => pruneBeyondMemberBoundIfDue(db, log));

      expect(err).toBeInstanceOf(ForeignKeysOffError);
      expect((err as Error).message).toBe(
        "membership: couldn't turn foreign keys back on after a prune that failed (disk I/O error): they're still off",
      );
      expect(artistTitles()).toContain("Bob Dylan");
      expect(pruneState().boundHash).toBeNull();
    });

    it("logs a VACUUM that fails after the prune committed as space not reclaimed, and still records it", () => {
      const dir = mkdtempSync(path.join(tmpdir(), "legato-prune-"));
      let onDisk: Database | undefined;
      try {
        onDisk = crawlOnDisk(path.join(dir, "legato.db"));
        const exec = onDisk.exec.bind(onDisk);
        Object.assign(onDisk, {
          exec: (sql: string) => {
            if (sql === "VACUUM") throw new Error("database or disk is full");
            exec(sql);
          },
        });

        const pruned = pruneBeyondMemberBoundIfDue(onDisk, log);

        expect(pruned).toMatchObject({ artists: 2000, reclaimedBytes: 0, reclaimError: "database or disk is full" });
        expect(logged.map(([level]) => level)).toEqual(["info", "warn"]);
        expect(logged[0]![1]).toMatch(/^membership: removed 2000 artist\(s\), .* past the membership bound in \d+\.\d s/);
        expect(logged[1]![1]).toBe(
          "membership: the prune is done, but couldn't reclaim the space it freed: database or disk is full. " +
            "SQLite reuses the free pages for new rows.",
        );
        expect(
          onDisk.prepare("SELECT COUNT(*) AS n FROM nodes WHERE type = 'artist'").get() as { n: number },
        ).toEqual({ n: 1 });
        expect(pruneState(onDisk)).toEqual({ boundHash: BOUND_HASH, mayHaveShrunk: 0 });
      } finally {
        onDisk?.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

// Issue #321: what can take an artist out of the bound marks the database,
// so the next start prunes. Nothing else does: a file that leaves the
// library is only marked missing, and its recording keeps its edges
// (scan/scanner.ts's markMissing), so the bound doesn't change.
describe("marking the bound as maybe shrunk", () => {
  const mayHaveShrunk = () =>
    (db.prepare("SELECT bound_may_have_shrunk AS v FROM member_bound_prune").get() as { v: number }).v === 1;

  let root: number;

  beforeEach(() => {
    root = (db.prepare("INSERT INTO library_roots (path) VALUES ('/music') RETURNING id").get() as { id: number }).id;
  });

  // One scanned file, tagged. Returns the file's id and its recording's.
  function addFile(tags: Record<string, unknown>): { file: number; recording: number } {
    const recording = makeNode("recording", String(tags.title));
    db.prepare("INSERT INTO recordings (node_id) VALUES (?)").run(recording);
    const file = db
      .prepare(
        `INSERT INTO files (recording_node_id, library_root_id, file_path, file_mtime, file_size, tags_raw, match_source)
         VALUES (?, ?, ?, datetime('now'), 0, ?, 'unmatched') RETURNING id`,
      )
      .get(recording, root, `/music/${tags.title}.flac`, JSON.stringify(tags)) as { id: number };
    return { file: file.id, recording };
  }

  function retag(file: number, tags: Record<string, unknown> | null): void {
    db.prepare("UPDATE files SET tags_raw = ? WHERE id = ?").run(tags && JSON.stringify(tags), file);
  }

  function artistId(title: string): number {
    return (db.prepare("SELECT id FROM nodes WHERE type = 'artist' AND title = ?").get(title) as { id: number }).id;
  }

  it("is set when a re-derive drops a person from a recording, and not when it derives the same people", () => {
    const { file } = addFile({ title: "Something", artist: "The Beatles", producer: ["George Martin"] });
    deriveLocalEdges(db, file);
    deriveLocalEdges(db, file);
    expect(mayHaveShrunk()).toBe(false);

    retag(file, { title: "Something", artist: "The Beatles" });
    deriveLocalEdges(db, file);
    expect(mayHaveShrunk()).toBe(true);
  });

  it("is set when a file's tags can't be read any more", () => {
    const { file } = addFile({ title: "Something", artist: "The Beatles" });
    deriveLocalEdges(db, file);

    retag(file, null);
    deriveLocalEdges(db, file);

    expect(mayHaveShrunk()).toBe(true);
  });

  it("is set when MusicBrainz credits a recording without someone it credited before", () => {
    const recording = makeNode("recording", "Something");
    const credit = (artistName: string) => ({ type: "producer", artistName, attributes: [] });
    applyCredits(db, recording, [credit("George Martin"), credit("Geoff Emerick")]);
    applyCredits(db, recording, [credit("Geoff Emerick"), credit("George Martin")]);
    expect(mayHaveShrunk()).toBe(false);

    applyCredits(db, recording, [credit("George Martin")]);
    expect(mayHaveShrunk()).toBe(true);
  });

  it("is set when a member lookup drops a pair, and not when it finds the same pairs or more", () => {
    const george = makeNode("artist", "George Harrison");
    applyMemberRelations(db, george, [{ direction: "forward", name: "The Beatles" }]);
    applyMemberRelations(db, george, [
      { direction: "forward", name: "The Beatles" },
      { direction: "forward", name: "Traveling Wilburys" },
    ]);
    expect(mayHaveShrunk()).toBe(false);

    applyMemberRelations(db, george, [{ direction: "forward", name: "Traveling Wilburys" }]);
    expect(mayHaveShrunk()).toBe(true);
  });

  it("is set when a manual edge that touches an artist is deleted, and not for one between other nodes", async () => {
    const app = Fastify();
    await app.register(edgesRoutes(db));
    const manual = (from: number, to: number, type: string) =>
      (
        db
          .prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, ?, 'manual') RETURNING id")
          .get(from, to, type) as { id: number }
      ).id;
    const sampled = manual(makeNode("recording", "A"), makeNode("recording", "B"), "sampled_in");
    const membership = manual(makeNode("artist", "Bob Dylan"), makeNode("artist", "The Band"), "member_of");

    expect((await app.inject({ method: "DELETE", url: `/edges/${sampled}` })).statusCode).toBe(204);
    expect(mayHaveShrunk()).toBe(false);

    expect((await app.inject({ method: "DELETE", url: `/edges/${membership}` })).statusCode).toBe(204);
    expect(mayHaveShrunk()).toBe(true);
  });

  // The review's case, through the code a real server runs: a recompute
  // after the user retags a band's tracks, then a restart.
  it("leads the next start to remove a retagged band's crawled members, and a start after that to skip the bound", () => {
    const beatles = addFile({ title: "Something", artist: "The Beatles", album: "Abbey Road" });
    addFile({ title: "Creep", artist: "Radiohead", album: "Pablo Honey" });
    recompute(db);
    // What the band's member lookups found: its members, and their groups.
    applyMemberRelations(db, artistId("The Beatles"), [{ direction: "backward", name: "George Harrison" }]);
    applyMemberRelations(db, artistId("George Harrison"), [
      { direction: "forward", name: "The Beatles" },
      { direction: "forward", name: "Traveling Wilburys" },
    ]);
    const log = () => {};
    expect(pruneBeyondMemberBoundIfDue(db, log)).toMatchObject({ artists: 0 });

    // A scan that changes nothing leaves the next start nothing to do.
    recompute(db);
    expect(mayHaveShrunk()).toBe(false);
    expect(pruneBeyondMemberBoundIfDue(db, log)).toBeNull();

    // The user retags the band's tracks as someone else's.
    retag(beatles.file, { title: "Something", artist: "Radiohead", album: "Abbey Road" });
    recompute(db);
    expect(mayHaveShrunk()).toBe(true);

    expect(pruneBeyondMemberBoundIfDue(db, log)).toMatchObject({ artists: 3 });
    expect(artistTitles()).toEqual(["Radiohead"]);
    expect(pruneBeyondMemberBoundIfDue(db, log)).toBeNull();
  });
});
