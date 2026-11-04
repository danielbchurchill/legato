import { beforeEach, describe, expect, it } from "bun:test";
import Fastify from "fastify";
import type { Database } from "../sqlite.js";
import { openDb } from "../db.js";
import { foldTitle, matchTier, search, searchLimit, searchRoutes } from "./search.js";

let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
});

function node(type: string, title: string): number {
  return (db.prepare("INSERT INTO nodes (type, title) VALUES (?, ?) RETURNING id").get(type, title) as { id: number }).id;
}

function edge(from: number, to: number, type: string): void {
  db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, ?, 'local')").run(from, to, type);
}

// A recording with one file, so it can be played.
function track(title: string, links: { artist?: number; album?: number; producer?: number } = {}): number {
  const id = node("recording", title);
  db.prepare("INSERT INTO recordings (node_id) VALUES (?)").run(id);
  const root = db.prepare("INSERT INTO library_roots (path) VALUES (?) RETURNING id").get(`/fake/${id}`) as { id: number };
  db.prepare(
    "INSERT INTO files (recording_node_id, library_root_id, file_path, file_mtime, file_size) VALUES (?, ?, ?, datetime('now'), 0)",
  ).run(id, root.id, `/fake/${id}.flac`);
  if (links.artist != null) edge(id, links.artist, "performed_by");
  if (links.album != null) edge(id, links.album, "appears_on");
  if (links.producer != null) edge(id, links.producer, "produced_by");
  return id;
}

function play(recording: number, times: number): void {
  const file = db.prepare("SELECT id FROM files WHERE recording_node_id = ?").get(recording) as { id: number };
  for (let i = 0; i < times; i++) {
    db.prepare("INSERT INTO plays (recording_node_id, file_id, started_at, ms_played) VALUES (?, ?, datetime('now'), 1000)").run(
      recording,
      file.id,
    );
  }
}

function artist(title: string, trackCount = 0): number {
  const id = node("artist", title);
  db.prepare("INSERT INTO artists (node_id, track_count) VALUES (?, ?)").run(id, trackCount);
  return id;
}

function album(title: string, trackCount = 0): number {
  const id = node("release", title);
  db.prepare("INSERT INTO albums (node_id, track_count) VALUES (?, ?)").run(id, trackCount);
  return id;
}

const titles = (query: string, limit = 100) => search(db, query, limit).map((hit) => hit.title);

describe("search ranking (#463)", () => {
  it("puts the most played artist before a producer of the same name, as on the reference library", () => {
    const tomczak = node("credit", "Danny Tomczak");
    const brown = artist("Danny Brown", 12);
    play(track("Ain't It Funny", { artist: brown, producer: tomczak }), 3);
    expect(titles("Danny")).toEqual(["Danny Brown", "Danny Tomczak"]);
    expect(search(db, "Danny", 1)).toEqual([{ id: brown, type: "artist", title: "Danny Brown" }]);
  });

  it("orders kinds artists, albums, tracks, then producers and engineers", () => {
    const producer = node("credit", "Danny Producer");
    const record = album("Danny's Song");
    track("Danny Boy", { album: record, producer });
    artist("Danny Brown");
    expect(titles("danny")).toEqual(["Danny Brown", "Danny's Song", "Danny Boy", "Danny Producer"]);
  });

  it("puts an exact match first, whatever its kind", () => {
    artist("Danny Brown");
    album("Danny");
    node("credit", "Danny Tomczak");
    track("Danny Boy");
    expect(titles("Danny")[0]).toBe("Danny");

    const exactArtist = artist("Danny");
    const first = search(db, "Danny", 10);
    // Two exact matches: the artist, then the album, by the kind order.
    expect(first.slice(0, 2).map((hit) => [hit.type, hit.title])).toEqual([
      ["artist", "Danny"],
      ["release", "Danny"],
    ]);
    expect(first[0].id).toBe(exactArtist);
  });

  it("matches exactly ignoring case, accents and outer spaces", () => {
    artist("Beyoncé Knowles");
    album("Beyoncé");
    expect(titles("  beyonce ")).toEqual(["Beyoncé", "Beyoncé Knowles"]);
    expect(foldTitle("  Sigur Rós ")).toBe("sigur ros");
  });

  it("an exact producer still comes before artists that only start with the query", () => {
    artist("Madlib Invazion");
    node("credit", "Madlib");
    expect(titles("madlib")).toEqual(["Madlib", "Madlib Invazion"]);
  });

  it("breaks ties within a kind by plays, then by tracks", () => {
    const brown = artist("Danny Brown", 5);
    const elfman = artist("Danny Elfman", 40);
    const harle = artist("Danny Harle", 9);
    // Unplayed: the most tracks first.
    expect(titles("danny")).toEqual(["Danny Elfman", "Danny Harle", "Danny Brown"]);
    play(track("Grown Up", { artist: brown }), 2);
    play(track("Batman Theme", { artist: elfman }), 1);
    // Played: plays first, whatever the track counts.
    expect(titles("danny")).toEqual(["Danny Brown", "Danny Elfman", "Danny Harle"]);
    expect(harle).toBeGreaterThan(0);
  });

  it("counts an album's and a producer's plays through their tracks", () => {
    const quiet = album("Danny Album One", 10);
    const loud = album("Danny Album Two", 2);
    play(track("A", { album: loud }), 4);
    track("B", { album: quiet });
    expect(titles("danny album")).toEqual(["Danny Album Two", "Danny Album One"]);

    const busy = node("credit", "Rick Producer");
    const idle = node("credit", "Rick Engineer");
    track("C", { producer: busy });
    track("D", { producer: busy });
    track("E", { producer: idle });
    // Unplayed, the producer on more tracks first; then plays win.
    expect(titles("rick")).toEqual(["Rick Producer", "Rick Engineer"]);
    play(track("F", { producer: idle }), 1);
    expect(titles("rick")).toEqual(["Rick Engineer", "Rick Producer"]);
  });

  it("ranks a better text match first within a kind, before plays", () => {
    const steely = artist("Steely Dan");
    artist("Tommy Danford");
    artist("Dan Deacon");
    play(track("Aja", { artist: steely }), 50);
    // Starts with the query, then the query as a whole word, then the rest.
    expect(titles("dan")).toEqual(["Dan Deacon", "Steely Dan", "Tommy Danford"]);
    expect(matchTier("Dan Deacon", "dan")).toBe(1);
    expect(matchTier("Steely Dan", "dan")).toBe(2);
    expect(matchTier("Tommy Danford", "dan")).toBe(3);
    expect(matchTier("Dan", " DAN ")).toBe(0);
  });

  it("leaves out labels, years and works, so they don't use up the limit", () => {
    node("label", "Danny Records");
    node("year", "1999");
    node("work", "Danny Boy (composition)");
    artist("Danny Brown");
    expect(titles("danny")).toEqual(["Danny Brown"]);
    expect(titles("1999")).toEqual([]);
  });

  it("never cuts a better kind off behind weaker tracks at the limit", () => {
    // Short track titles are what bm25 alone put first.
    for (let i = 0; i < 120; i++) track(`Danny ${i}`);
    artist("Danny Brown And The Very Long Band Name");
    const hits = search(db, "danny", 100);
    expect(hits).toHaveLength(100);
    expect(hits[0].title).toBe("Danny Brown And The Very Long Band Name");
    expect(hits.slice(1).every((hit) => hit.type === "recording")).toBe(true);
  });

  it("finds nothing for nothing, or for only punctuation", () => {
    artist("Danny Brown");
    expect(search(db, "", 20)).toEqual([]);
    expect(search(db, "  ", 20)).toEqual([]);
    expect(search(db, "!!!", 20)).toEqual([]);
  });
});

describe("GET /search", () => {
  it("answers with the rows already in order, within the limit", async () => {
    const app = Fastify();
    await app.register(searchRoutes(db), { prefix: "/api/v1" });
    node("credit", "Danny Tomczak");
    artist("Danny Brown");
    album("Danny");
    const res = await app.inject({ method: "GET", url: "/api/v1/search?q=Danny&limit=2" });
    expect(res.json()).toEqual([
      expect.objectContaining({ type: "release", title: "Danny" }),
      expect.objectContaining({ type: "artist", title: "Danny Brown" }),
    ]);
  });

  it("keeps the limit between 1 and 100, 20 when it isn't a number", () => {
    expect(searchLimit(undefined)).toBe(20);
    expect(searchLimit("5")).toBe(5);
    expect(searchLimit("500")).toBe(100);
    expect(searchLimit("0")).toBe(20);
    expect(searchLimit("abc")).toBe(20);
  });
});
