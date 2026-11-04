import { beforeEach, describe, expect, it } from "bun:test";
import Fastify from "fastify";
import type { Database } from "../sqlite.js";
import { openDb } from "../db.js";
import { findBridgeMembers, refreshBridgeMembers } from "./bridges.js";
import { recompute } from "../recompute.js";
import { applyMemberRelations, pruneBeyondMemberBound } from "../enrich/members.js";
import { libraryRoutes } from "../routes/library.js";
import { statsRoutes } from "../routes/stats.js";
import { nodesRoutes } from "../routes/nodes.js";
import { libraryChanged } from "../libraryRevision.js";

let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
});

describe("findBridgeMembers: who is and isn't a bridge member", () => {
  // Ids as on a small library: 1 The Beatles, 2 The Traveling Wilburys,
  // 3 Bob Dylan, 4 Tom Petty have tracks; 10 George Harrison, 11 Ringo
  // Starr, 12 Jim Keltner and 20 a band none of the files are by don't.
  const onMap = new Set([1, 2, 3, 4]);

  it("is a member of two of your artists, not a member of one", () => {
    const bridges = findBridgeMembers(
      [
        { fromNode: 10, toNode: 1 },
        { fromNode: 10, toNode: 2 },
        { fromNode: 11, toNode: 1 },
        { fromNode: 12, toNode: 2 },
      ],
      onMap,
    );
    expect([...bridges]).toEqual([[10, [1, 2]]]);
  });

  it("is a band none of your files are by, when two of its members are your artists", () => {
    const bridges = findBridgeMembers(
      [
        { fromNode: 3, toNode: 20 },
        { fromNode: 4, toNode: 20 },
      ],
      onMap,
    );
    expect([...bridges]).toEqual([[20, [3, 4]]]);
  });

  it("is never an artist with tracks of its own, however many of your artists it links", () => {
    const bridges = findBridgeMembers(
      [
        { fromNode: 3, toNode: 2 },
        { fromNode: 3, toNode: 1 },
      ],
      onMap,
    );
    expect(bridges.size).toBe(0);
  });

  it("counts each of your artists once, whichever way the edges point", () => {
    const bridges = findBridgeMembers(
      [
        { fromNode: 10, toNode: 1 },
        { fromNode: 1, toNode: 10 },
      ],
      onMap,
    );
    expect(bridges.size).toBe(0);
  });

  it("doesn't count a link to an artist that isn't on the map", () => {
    // Harrison in The Beatles and in a band with no files: one of yours.
    const bridges = findBridgeMembers(
      [
        { fromNode: 10, toNode: 1 },
        { fromNode: 10, toNode: 20 },
      ],
      onMap,
    );
    expect(bridges.size).toBe(0);
  });
});

function insertFile(tags: Record<string, unknown>): number {
  const node = db.prepare("INSERT INTO nodes (type, title) VALUES ('recording', 'x') RETURNING id").get() as { id: number };
  db.prepare("INSERT INTO recordings (node_id) VALUES (?)").run(node.id);
  const root = db.prepare("INSERT INTO library_roots (path) VALUES (?) RETURNING id").get(`/fake/${node.id}`) as {
    id: number;
  };
  db.prepare(
    `INSERT INTO files (recording_node_id, library_root_id, file_path, file_mtime, file_size, tags_raw)
     VALUES (?, ?, ?, datetime('now'), 0, ?)`,
  ).run(node.id, root.id, `/fake/${node.id}.flac`, JSON.stringify(tags));
  return node.id;
}

function artist(title: string): number {
  const row = db.prepare("SELECT id FROM nodes WHERE type = 'artist' AND title = ?").get(title) as { id: number } | undefined;
  if (row) return row.id;
  return (db.prepare("INSERT INTO nodes (type, title) VALUES ('artist', ?) RETURNING id").get(title) as { id: number }).id;
}

function memberOf(member: number, group: number): void {
  db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'member_of', 'musicbrainz')").run(
    member,
    group,
  );
}

function artistsRow(nodeId: number) {
  return db.prepare("SELECT track_count AS tracks, album_count AS albums FROM artists WHERE node_id = ?").get(nodeId) as
    | { tracks: number; albums: number }
    | undefined;
}

function seedOf(nodeId: number) {
  return db
    .prepare("SELECT seed_x AS x, seed_y AS y FROM positions WHERE node_id = ? AND granularity = 'tracks'")
    .get(nodeId) as { x: number; y: number } | undefined;
}

function midpoint(a: number, b: number) {
  const [p, q] = [seedOf(a)!, seedOf(b)!];
  return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
}

// The reference library, cut down: both bands, Dylan and Petty, and no
// record of George Harrison's own.
function referenceLibrary() {
  insertFile({ artist: "The Beatles", album: "Abbey Road", releaseDate: "1969" });
  insertFile({ artist: "The Beatles", album: "Abbey Road", releaseDate: "1969" });
  insertFile({ artist: "The Traveling Wilburys", album: "Vol. 1", releaseDate: "1988" });
  insertFile({ artist: "Bob Dylan", album: "Blonde on Blonde", releaseDate: "1966" });
  insertFile({ artist: "Tom Petty", album: "Full Moon Fever", releaseDate: "1989" });
  recompute(db);
  return {
    beatles: artist("The Beatles"),
    wilburys: artist("The Traveling Wilburys"),
    dylan: artist("Bob Dylan"),
    petty: artist("Tom Petty"),
  };
}

describe("bridge members after a scan", () => {
  it("places George Harrison between The Beatles and the Wilburys, and leaves Ringo and Keltner off", () => {
    const { beatles, wilburys, dylan, petty } = referenceLibrary();
    const harrison = artist("George Harrison");
    const ringo = artist("Ringo Starr");
    const keltner = artist("Jim Keltner");
    memberOf(harrison, beatles);
    memberOf(harrison, wilburys);
    memberOf(ringo, beatles);
    memberOf(keltner, wilburys);
    memberOf(dylan, wilburys);
    memberOf(petty, wilburys);

    recompute(db);

    expect(artistsRow(harrison)).toEqual({ tracks: 0, albums: 0 });
    expect(seedOf(harrison)).toEqual(midpoint(beatles, wilburys));
    expect(artistsRow(ringo)).toBeUndefined();
    expect(seedOf(ringo)).toBeUndefined();
    expect(artistsRow(keltner)).toBeUndefined();
    expect(seedOf(keltner)).toBeUndefined();
  });

  it("draws Harrison's, Dylan's and Petty's band edges: the map gets both ends of each", async () => {
    const { beatles, wilburys, dylan, petty } = referenceLibrary();
    const harrison = artist("George Harrison");
    memberOf(harrison, beatles);
    memberOf(harrison, wilburys);
    memberOf(dylan, wilburys);
    memberOf(petty, wilburys);
    memberOf(artist("Ringo Starr"), beatles);
    recompute(db);

    const app = Fastify();
    await app.register(nodesRoutes(db), { prefix: "/api/v1" });
    const nodes = new Set(((await app.inject("/api/v1/nodes")).json() as { id: number }[]).map((n) => n.id));
    const memberEdges = ((await app.inject("/api/v1/edges")).json() as { from_node: number; to_node: number; type: string }[])
      .filter((e) => e.type === "member_of")
      .filter((e) => nodes.has(e.from_node) && nodes.has(e.to_node))
      .map((e) => [e.from_node, e.to_node]);

    expect(nodes.has(harrison)).toBe(true);
    expect(memberEdges).toEqual([
      [harrison, beatles],
      [harrison, wilburys],
      [dylan, wilburys],
      [petty, wilburys],
    ]);
  });

  it("places a band none of the files are by, when two of its members are on the map", () => {
    insertFile({ artist: "Bob Dylan", album: "Blonde on Blonde", releaseDate: "1966" });
    insertFile({ artist: "Tom Petty", album: "Full Moon Fever", releaseDate: "1989" });
    recompute(db);
    const [dylan, petty, wilburys] = [artist("Bob Dylan"), artist("Tom Petty"), artist("Traveling Wilburys")];
    memberOf(dylan, wilburys);
    memberOf(petty, wilburys);

    recompute(db);

    expect(artistsRow(wilburys)).toEqual({ tracks: 0, albums: 0 });
    expect(seedOf(wilburys)).toEqual(midpoint(dylan, petty));
  });

  it("changes no count of artists with records: not the Artists tab, its header or /stats", async () => {
    const { beatles, wilburys } = referenceLibrary();
    const app = Fastify();
    await app.register(libraryRoutes(db), { prefix: "/api/v1" });
    await app.register(statsRoutes(db), { prefix: "/api/v1" });
    const counts = async () => {
      libraryChanged();
      const tab = (await app.inject("/api/v1/library/artists?limit=100")).json() as {
        items: { id: number }[];
        total: number;
      };
      const stats = (await app.inject("/api/v1/stats")).json() as { artists: number };
      return { listed: tab.items.map((a) => a.id).sort((a, b) => a - b), total: tab.total, stats: stats.artists };
    };
    const before = await counts();

    const harrison = artist("George Harrison");
    memberOf(harrison, beatles);
    memberOf(harrison, wilburys);
    recompute(db);

    expect(artistsRow(harrison)).toEqual({ tracks: 0, albums: 0 });
    const after = await counts();
    expect(after).toEqual(before);
    expect(after.listed).not.toContain(harrison);
    expect(after.total).toBe(4);
  });

  it("stays inside the membership bound, so the startup prune keeps it", () => {
    const { beatles, wilburys } = referenceLibrary();
    const harrison = artist("George Harrison");
    memberOf(harrison, beatles);
    memberOf(harrison, wilburys);
    recompute(db);

    pruneBeyondMemberBound(db);

    expect(artistsRow(harrison)).toEqual({ tracks: 0, albums: 0 });
    expect(seedOf(harrison)).toBeDefined();
  });
});

describe("refreshBridgeMembers, between scans", () => {
  it("places Harrison as soon as his own lookup finds both bands, without a scan", () => {
    const { beatles, wilburys } = referenceLibrary();
    const harrison = artist("George Harrison");

    applyMemberRelations(db, harrison, [
      { direction: "forward", name: "The Beatles" },
      { direction: "forward", name: "The Traveling Wilburys" },
    ]);

    expect(artistsRow(harrison)).toEqual({ tracks: 0, albums: 0 });
    expect(seedOf(harrison)).toEqual(midpoint(beatles, wilburys));
  });

  it("places him from the bands' side too, once the second band's lookup names him", () => {
    const { beatles, wilburys } = referenceLibrary();
    applyMemberRelations(db, beatles, [
      { direction: "backward", name: "George Harrison" },
      { direction: "backward", name: "Ringo Starr" },
    ]);
    const harrison = artist("George Harrison");
    expect(artistsRow(harrison)).toBeUndefined();

    applyMemberRelations(db, wilburys, [{ direction: "backward", name: "George Harrison" }]);

    expect(artistsRow(harrison)).toEqual({ tracks: 0, albums: 0 });
    expect(artistsRow(artist("Ringo Starr"))).toBeUndefined();
  });

  it("takes him off the map when a lookup leaves him in one band", () => {
    referenceLibrary();
    const harrison = artist("George Harrison");
    applyMemberRelations(db, harrison, [
      { direction: "forward", name: "The Beatles" },
      { direction: "forward", name: "The Traveling Wilburys" },
    ]);

    applyMemberRelations(db, harrison, [{ direction: "forward", name: "The Beatles" }]);

    expect(artistsRow(harrison)).toBeUndefined();
    expect(seedOf(harrison)).toBeUndefined();
  });

  it("on a start, places the bridge members a database already has edges for, then writes nothing", () => {
    const { beatles, wilburys } = referenceLibrary();
    const harrison = artist("George Harrison");
    memberOf(harrison, beatles);
    memberOf(harrison, wilburys);

    expect(refreshBridgeMembers(db)).toEqual({ added: [harrison], removed: [] });
    expect(seedOf(harrison)).toEqual(midpoint(beatles, wilburys));

    const changes = () => (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    const before = changes();
    expect(refreshBridgeMembers(db)).toEqual({ added: [], removed: [] });
    expect(changes()).toBe(before);
  });

  it("keeps a position the bridge member already has", () => {
    const { beatles, wilburys } = referenceLibrary();
    const harrison = artist("George Harrison");
    db.prepare(
      "INSERT INTO positions (node_id, granularity, seed_x, seed_y, user_x, user_y) VALUES (?, 'tracks', 1, 2, 30, 40)",
    ).run(harrison);
    memberOf(harrison, beatles);
    memberOf(harrison, wilburys);

    refreshBridgeMembers(db);

    expect(
      db.prepare("SELECT seed_x, seed_y, user_x, user_y FROM positions WHERE node_id = ?").get(harrison),
    ).toEqual({ seed_x: 1, seed_y: 2, user_x: 30, user_y: 40 });
  });
});
