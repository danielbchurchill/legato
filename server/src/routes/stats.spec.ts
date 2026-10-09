import { beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "../sqlite.js";
import { openDb } from "../db.js";
import Fastify, { type FastifyInstance } from "fastify";
import { statsRoutes } from "./stats.js";

let db: Database;
let app: FastifyInstance;

beforeEach(async () => {
  db = openDb(":memory:");
  app = Fastify();
  await app.register(statsRoutes(db), { prefix: "/api/v1" });
});

function makeNode(type: string, title: string): number {
  return (db.prepare("INSERT INTO nodes (type, title) VALUES (?, ?) RETURNING id").get(type, title) as { id: number })
    .id;
}

function edge(fromNode: number, toNode: number, type: string): void {
  db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, ?, 'local')").run(
    fromNode,
    toNode,
    type,
  );
}

// A recording with one file, credited to `artist` on `album`.
function track(title: string, artist: number, album: number): number {
  const id = makeNode("recording", title);
  db.prepare("INSERT INTO recordings (node_id) VALUES (?)").run(id);
  const root = db.prepare("INSERT INTO library_roots (path) VALUES (?) RETURNING id").get(`/fake/${id}`) as {
    id: number;
  };
  db.prepare(
    "INSERT INTO files (recording_node_id, library_root_id, file_path, file_mtime, file_size) VALUES (?, ?, ?, datetime('now'), 0)",
  ).run(id, root.id, `/fake/${id}.flac`);
  edge(id, artist, "performed_by");
  edge(id, album, "appears_on");
  return id;
}

function play(recording: number, times: number): void {
  const file = db.prepare("SELECT id FROM files WHERE recording_node_id = ?").get(recording) as { id: number };
  for (let i = 0; i < times; i++) {
    db.prepare(
      "INSERT INTO plays (recording_node_id, file_id, started_at, ms_played) VALUES (?, ?, datetime('now'), 1000)",
    ).run(recording, file.id);
  }
}

async function getStats() {
  return (await app.inject({ method: "GET", url: "/api/v1/stats" })).json();
}

describe("GET /stats top artist, album and track", () => {
  it("is null with nothing played", async () => {
    const artist = makeNode("artist", "Someone");
    track("Song", artist, makeNode("release", "Record"));

    expect(await getStats()).toMatchObject({ topArtist: null, topAlbum: null, topTrack: null });
  });

  it("adds up plays through each track's performer and record", async () => {
    const often = makeNode("artist", "Often");
    const once = makeNode("artist", "Once");
    const first = makeNode("release", "First");
    const second = makeNode("release", "Second");
    const a = track("A", often, first);
    const b = track("B", often, second);
    const c = track("C", once, second);
    play(a, 2);
    play(b, 2);
    play(c, 3);

    // Often has four plays over two records; Second has five over two
    // artists; C alone is the most played track.
    expect(await getStats()).toMatchObject({
      topArtist: { id: often, title: "Often", playCount: 4 },
      topAlbum: { id: second, title: "Second", playCount: 5 },
      topTrack: { id: c, title: "C", playCount: 3 },
    });
  });

  it("breaks a tie by the lower id", async () => {
    const lower = makeNode("artist", "Lower");
    const higher = makeNode("artist", "Higher");
    const record = makeNode("release", "Record");
    play(track("A", higher, record), 1);
    play(track("B", lower, record), 1);

    expect((await getStats()).topArtist).toEqual({ id: lower, title: "Lower", playCount: 1 });
  });
});
