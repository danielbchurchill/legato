import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "../db.js";
import Fastify, { type FastifyInstance } from "fastify";
import { libraryRoutes } from "./library.js";

let db: Database.Database;
let app: FastifyInstance;

beforeEach(async () => {
  db = openDb(":memory:");
  app = Fastify();
  await app.register(libraryRoutes(db), { prefix: "/api/v1" });
});

function makeNode(type: string, title: string, createdAt = "2020-01-01 00:00:00"): number {
  const row = db
    .prepare("INSERT INTO nodes (type, title, created_at) VALUES (?, ?, ?) RETURNING id")
    .get(type, title, createdAt) as { id: number };
  return row.id;
}

function makeAlbum(
  title: string,
  opts: { artistId?: number | null; trackCount?: number; totalDurationMs?: number; year?: number | null; createdAt?: string } = {},
): number {
  const id = makeNode("release", title, opts.createdAt);
  db.prepare(
    `INSERT INTO albums (node_id, primary_artist_node_id, track_count, total_duration_ms, year_min, year_max)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, opts.artistId ?? null, opts.trackCount ?? 0, opts.totalDurationMs ?? 0, opts.year ?? null, opts.year ?? null);
  return id;
}

function makeRecording(
  title: string,
  opts: { durationMs?: number | null; createdAt?: string; format?: string | null } = {},
): number {
  const id = makeNode("recording", title, opts.createdAt);
  db.prepare("INSERT INTO recordings (node_id, canonical_duration_ms) VALUES (?, ?)").run(id, opts.durationMs ?? null);
  const root = db.prepare("INSERT INTO library_roots (path) VALUES (?) RETURNING id").get(`/fake/${id}`) as {
    id: number;
  };
  db.prepare(
    `INSERT INTO files (recording_node_id, library_root_id, file_path, file_mtime, file_size, format)
     VALUES (?, ?, ?, datetime('now'), 0, ?)`,
  ).run(id, root.id, `/fake/${id}.flac`, opts.format ?? null);
  return id;
}

function edge(fromNode: number, toNode: number, type: string): void {
  db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, ?, 'local')").run(fromNode, toNode, type);
}

function play(recordingNodeId: number, startedAt: string): void {
  const file = db.prepare("SELECT id FROM files WHERE recording_node_id = ?").get(recordingNodeId) as { id: number };
  db.prepare(
    "INSERT INTO plays (recording_node_id, file_id, started_at, ms_played) VALUES (?, ?, ?, 200000)",
  ).run(recordingNodeId, file.id, startedAt);
}

async function getAlbums(query = "") {
  const res = await app.inject({ method: "GET", url: `/api/v1/library/albums${query}` });
  return res.json();
}

async function getTracks(query = "") {
  const res = await app.inject({ method: "GET", url: `/api/v1/library/tracks${query}` });
  return res.json();
}

describe("GET /library/albums", () => {
  it("lists albums with their primary artist, year, and cover-less default", async () => {
    const artist = makeNode("artist", "Genesis Owusu");
    const albumId = makeAlbum("Struggler", { artistId: artist, trackCount: 15, totalDurationMs: 3_000_000, year: 2021 });

    const { items, total } = await getAlbums();
    expect(total).toBe(1);
    expect(items).toEqual([
      {
        id: albumId,
        title: "Struggler",
        artistId: artist,
        artistName: "Genesis Owusu",
        year: 2021,
        trackCount: 15,
        totalDurationMs: 3_000_000,
        dateAdded: "2020-01-01 00:00:00",
        coverHash: null,
      },
    ]);
  });

  it("sorts by title ascending by default", async () => {
    makeAlbum("Zed");
    makeAlbum("Alpha");

    const { items } = await getAlbums();
    expect(items.map((a: { title: string }) => a.title)).toEqual(["Alpha", "Zed"]);
  });

  it("sorts by year, with undated albums last regardless of direction", async () => {
    makeAlbum("No year");
    makeAlbum("Early", { year: 1990 });
    makeAlbum("Late", { year: 2020 });

    expect((await getAlbums("?sort=year&dir=asc")).items.map((a: { title: string }) => a.title)).toEqual([
      "Early",
      "Late",
      "No year",
    ]);
    expect((await getAlbums("?sort=year&dir=desc")).items.map((a: { title: string }) => a.title)).toEqual([
      "Late",
      "Early",
      "No year",
    ]);
  });

  it("sorts by recently played, derived from plays on the album's recordings", async () => {
    const older = makeAlbum("Older Play");
    const newer = makeAlbum("Newer Play");
    const neverPlayed = makeAlbum("Never Played");

    const olderTrack = makeRecording("Track A");
    edge(olderTrack, older, "appears_on");
    play(olderTrack, "2020-01-01 00:00:00");

    const newerTrack = makeRecording("Track B");
    edge(newerTrack, newer, "appears_on");
    play(newerTrack, "2024-01-01 00:00:00");

    const { items } = await getAlbums("?sort=recentlyPlayed&dir=desc");
    expect(items.map((a: { id: number }) => a.id)).toEqual([newer, older, neverPlayed]);
  });

  it("filters by album title or artist name", async () => {
    const artist = makeNode("artist", "Danny Brown");
    makeAlbum("Atrocity Exhibition", { artistId: artist });
    makeAlbum("Unrelated Release");

    expect((await getAlbums("?q=atrocity")).items).toHaveLength(1);
    expect((await getAlbums("?q=danny")).items).toHaveLength(1);
    expect((await getAlbums("?q=nothing+matches")).items).toHaveLength(0);
  });

  it("treats a literal % or _ in the query as a plain character, not a wildcard", async () => {
    makeAlbum("50% Off");
    makeAlbum("Something Else");

    expect((await getAlbums("?q=50%25"))).toMatchObject({ total: 1 });
  });

  it("paginates with limit and offset", async () => {
    for (let i = 0; i < 5; i++) makeAlbum(`Album ${i}`);

    const page1 = await getAlbums("?limit=2&offset=0");
    const page2 = await getAlbums("?limit=2&offset=2");
    expect(page1.total).toBe(5);
    expect(page1.items).toHaveLength(2);
    expect(page2.items).toHaveLength(2);
    expect(page1.items.map((a: { id: number }) => a.id)).not.toEqual(page2.items.map((a: { id: number }) => a.id));
  });

  it("falls back to the default sort for an unknown sort key rather than erroring", async () => {
    makeAlbum("Alpha");
    const res = await app.inject({ method: "GET", url: "/api/v1/library/albums?sort=not-a-real-column" });
    expect(res.statusCode).toBe(200);
  });
});

describe("GET /library/tracks", () => {
  it("lists a track with its resolved artist, album, format and duration", async () => {
    const artist = makeNode("artist", "Bob Dylan");
    const album = makeAlbum("Blood on the Tracks", { artistId: artist });
    const track = makeRecording("Tangled Up in Blue", { durationMs: 325_000, format: "FLAC" });
    edge(track, artist, "performed_by");
    edge(track, album, "appears_on");

    const { items, total } = await getTracks();
    expect(total).toBe(1);
    expect(items).toEqual([
      {
        id: track,
        title: "Tangled Up in Blue",
        artistId: artist,
        artistName: "Bob Dylan",
        albumId: album,
        albumTitle: "Blood on the Tracks",
        durationMs: 325_000,
        format: "FLAC",
        dateAdded: "2020-01-01 00:00:00",
      },
    ]);
  });

  it("only returns recording nodes, not albums or artists", async () => {
    makeNode("artist", "Some Artist");
    makeAlbum("Some Album");
    makeRecording("Some Track");

    const { total } = await getTracks();
    expect(total).toBe(1);
  });

  it("sorts by duration", async () => {
    makeRecording("Long", { durationMs: 400_000 });
    makeRecording("Short", { durationMs: 100_000 });

    const { items } = await getTracks("?sort=duration&dir=asc");
    expect(items.map((t: { title: string }) => t.title)).toEqual(["Short", "Long"]);
  });

  it("filters by track title, artist, or album", async () => {
    const artist = makeNode("artist", "Radiohead");
    const album = makeAlbum("OK Computer", { artistId: artist });
    const track = makeRecording("Paranoid Android");
    edge(track, artist, "performed_by");
    edge(track, album, "appears_on");
    makeRecording("Unrelated Track");

    expect((await getTracks("?q=paranoid")).total).toBe(1);
    expect((await getTracks("?q=radiohead")).total).toBe(1);
    expect((await getTracks("?q=ok+computer")).total).toBe(1);
    expect((await getTracks("?q=nothing+matches")).total).toBe(0);
  });

  it("a recording with more than one performed_by edge reports the lowest-id credit, same as GET /nodes", async () => {
    const track = makeRecording("Collab Track");
    const first = makeNode("artist", "First Credit");
    const second = makeNode("artist", "Second Credit");
    edge(track, first, "performed_by");
    edge(track, second, "performed_by");

    const { items } = await getTracks();
    expect(items[0].artistName).toBe("First Credit");
  });
});
