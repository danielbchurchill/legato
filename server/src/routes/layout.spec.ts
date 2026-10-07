import { beforeEach, describe, expect, it } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { Database } from "../sqlite.js";
import { openDb } from "../db.js";
import { recomputeAllLayouts } from "../layout/seed.js";
import { layoutRoutes } from "./layout.js";
import { nodesRoutes } from "./nodes.js";

// #274: the map's layout survives between visits because the client saves
// where its physics came to rest (PUT /layout/settled) and GET /nodes hands
// those spots back. These cover the server's half of that round trip, and
// the two things that must and mustn't clear it: "rebuild map" and a scan.

let db: Database;
let app: FastifyInstance;

type NodeRow = {
  id: number;
  seed_x: number;
  seed_y: number;
  user_x: number | null;
  user_y: number | null;
  settled_x: number | null;
  settled_y: number | null;
};

function makeNode(type: string, title: string): number {
  return (db.prepare("INSERT INTO nodes (type, title) VALUES (?, ?) RETURNING id").get(type, title) as { id: number })
    .id;
}

// One artist, one release, two recordings with files: enough for every
// node type the map positions.
function buildLibrary() {
  db.prepare("INSERT INTO library_roots (path) VALUES ('/fake')").run();
  const artist = makeNode("artist", "Nina Simone");
  const release = makeNode("release", "Pastel Blues");
  const recordings = [makeNode("recording", "Be My Husband"), makeNode("recording", "Sinnerman")];
  db.prepare("INSERT INTO artists (node_id, track_count, album_count) VALUES (?, 2, 1)").run(artist);
  db.prepare(
    "INSERT INTO albums (node_id, primary_artist_node_id, track_count, total_duration_ms, year_min, year_max) VALUES (?, ?, 2, 0, 1965, 1965)",
  ).run(release, artist);
  recordings.forEach((recording, i) => {
    db.prepare("INSERT INTO recordings (node_id) VALUES (?)").run(recording);
    db.prepare(
      "INSERT INTO files (recording_node_id, library_root_id, file_path, file_mtime, file_size) VALUES (?, (SELECT id FROM library_roots LIMIT 1), ?, datetime('now'), 0)",
    ).run(recording, `/fake/${i}.flac`);
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'performed_by', 'local')").run(
      recording,
      artist,
    );
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'appears_on', 'local')").run(
      recording,
      release,
    );
  });
  recomputeAllLayouts(db);
  return { artist, release, recordings };
}

async function graphNodes(): Promise<Map<number, NodeRow>> {
  const res = await app.inject({ method: "GET", url: "/nodes" });
  expect(res.statusCode).toBe(200);
  return new Map((res.json() as NodeRow[]).map((n) => [n.id, n]));
}

function saveSettled(positions: unknown) {
  return app.inject({ method: "PUT", url: "/layout/settled", payload: { positions } });
}

beforeEach(async () => {
  db = openDb(":memory:");
  app = Fastify();
  await app.register(layoutRoutes(db));
  await app.register(nodesRoutes(db));
});

describe("PUT /layout/settled (#274)", () => {
  it("hands saved resting spots back through GET /nodes, exactly as sent", async () => {
    const { artist, recordings } = buildLibrary();
    // Doubles with every bit of precision in use: the next visit has to
    // open on these exact numbers, not a rounding of them.
    const res = await saveSettled([
      { id: artist, x: 0.1 + 0.2, y: -1234.5678901234567 },
      { id: recordings[0], x: 1 / 3, y: Math.PI * 1e5 },
    ]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ saved: 2 });

    const nodes = await graphNodes();
    expect(nodes.get(artist)).toMatchObject({ settled_x: 0.1 + 0.2, settled_y: -1234.5678901234567 });
    expect(nodes.get(recordings[0])).toMatchObject({ settled_x: 1 / 3, settled_y: Math.PI * 1e5 });
    expect(nodes.get(recordings[1])).toMatchObject({ settled_x: null, settled_y: null });
  });

  it("leaves a node that was never dragged without a user position", async () => {
    const { recordings } = buildLibrary();
    await saveSettled([{ id: recordings[0], x: 5, y: 6 }]);
    expect((await graphNodes()).get(recordings[0])).toMatchObject({ user_x: null, user_y: null });
  });

  it("moves a dragged node's user position to where it came to rest after the drop", async () => {
    const { recordings } = buildLibrary();
    await app.inject({ method: "PATCH", url: `/nodes/${recordings[0]}/position`, payload: { x: 100, y: 200 } });

    // #46: the drop is a starting point. Physics carried it on to here.
    await saveSettled([{ id: recordings[0], x: 140, y: 180 }]);

    expect((await graphNodes()).get(recordings[0])).toMatchObject({
      user_x: 140,
      user_y: 180,
      settled_x: 140,
      settled_y: 180,
    });
  });

  it("rejects a body that isn't a list of finite { id, x, y }", async () => {
    const { artist } = buildLibrary();
    for (const positions of [
      undefined,
      "nope",
      [{ id: artist, x: 1 }],
      [{ id: artist, x: 1, y: null }],
      [{ id: "1", x: 1, y: 2 }],
    ]) {
      expect((await saveSettled(positions)).statusCode).toBe(400);
    }
    expect((await graphNodes()).get(artist)).toMatchObject({ settled_x: null });
  });

  it("ignores ids the map has no position for", async () => {
    buildLibrary();
    const res = await saveSettled([{ id: 999999, x: 1, y: 2 }]);
    expect(res.json()).toEqual({ saved: 0 });
  });
});

describe("PATCH /nodes/:id/position (#274)", () => {
  it("saves a drop as the node's resting spot too, so a drop while the layout is locked still reopens there", async () => {
    const { release } = buildLibrary();
    await saveSettled([{ id: release, x: 1, y: 1 }]);

    await app.inject({ method: "PATCH", url: `/nodes/${release}/position`, payload: { x: -40, y: 75 } });

    expect((await graphNodes()).get(release)).toMatchObject({ user_x: -40, user_y: 75, settled_x: -40, settled_y: 75 });
  });
});

describe("what keeps or clears a saved layout (#274)", () => {
  it("a scan's recompute leaves every saved spot alone", async () => {
    const { artist, release, recordings } = buildLibrary();
    await saveSettled([artist, release, ...recordings].map((id, i) => ({ id, x: i * 10, y: -i * 10 })));
    const before = await graphNodes();

    // A new track by the same artist, as an incremental scan would add it.
    const added = makeNode("recording", "Strange Fruit");
    db.prepare("INSERT INTO recordings (node_id) VALUES (?)").run(added);
    db.prepare(
      "INSERT INTO files (recording_node_id, library_root_id, file_path, file_mtime, file_size) VALUES (?, (SELECT id FROM library_roots LIMIT 1), '/fake/new.flac', datetime('now'), 0)",
    ).run(added);
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'performed_by', 'local')").run(
      added,
      artist,
    );
    recomputeAllLayouts(db);

    const after = await graphNodes();
    for (const [id, row] of before) {
      expect(after.get(id)).toMatchObject({ settled_x: row.settled_x, settled_y: row.settled_y });
    }
    expect(after.get(added)).toMatchObject({ settled_x: null, settled_y: null });
  });

  it("'rebuild map' clears every saved spot, so the map settles fresh", async () => {
    const { artist, recordings } = buildLibrary();
    await app.inject({ method: "PATCH", url: `/nodes/${recordings[0]}/position`, payload: { x: 3, y: 4 } });
    await saveSettled([{ id: artist, x: 1, y: 2 }]);

    const res = await app.inject({ method: "POST", url: "/layout/rebuild" });
    expect(res.statusCode).toBe(200);

    for (const row of (await graphNodes()).values()) {
      expect(row).toMatchObject({ user_x: null, user_y: null, settled_x: null, settled_y: null });
    }
  });
});
