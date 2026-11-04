import { beforeEach, describe, expect, it } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { Database } from "../sqlite.js";
import { openDb } from "../db.js";
import {
  getGapAlbums,
  getGapCounts,
  getGapFiles,
  getGapTracks,
  parseKinds,
  releaseMbid,
  tagManagerRoutes,
  type TagManagerField,
} from "./tag-manager.js";

/* #469: the gaps list grouped by album, sorted, filtered, paged, and its
 * counts from one query. */

let db: Database;
let root: number;

beforeEach(() => {
  db = openDb(":memory:");
  root = (db.prepare("INSERT INTO library_roots (path) VALUES ('/music') RETURNING id").get() as { id: number }).id;
});

function node(type: string, title: string, mbid: string | null = null): number {
  return (
    db.prepare("INSERT INTO nodes (type, title, mbid) VALUES (?, ?, ?) RETURNING id").get(type, title, mbid) as {
      id: number;
    }
  ).id;
}

function edge(from: number, to: number, type: string): void {
  db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, ?, 'local')").run(from, to, type);
}

type FileFields = {
  bpm?: number | null;
  label?: string | null;
  release_date?: string | null;
  release_type?: string | null;
  track_no?: number | null;
  disc_no?: number | null;
  missing_since?: string | null;
  tags_raw?: string | null;
};

let paths = 0;
function file(recording: number, fields: FileFields = {}): number {
  const f = {
    bpm: null,
    label: null,
    release_date: null,
    release_type: null,
    track_no: null,
    disc_no: null,
    missing_since: null,
    tags_raw: null,
    ...fields,
  };
  return (
    db
      .prepare(
        `INSERT INTO files (recording_node_id, library_root_id, file_path, file_mtime, file_size,
                            bpm, label, release_date, release_type, track_no, disc_no, missing_since, tags_raw)
         VALUES (?, ?, ?, datetime('now'), 0, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        recording,
        root,
        `/music/${++paths}.flac`,
        f.bpm,
        f.label,
        f.release_date,
        f.release_type,
        f.track_no,
        f.disc_no,
        f.missing_since,
        f.tags_raw,
      ) as {
      id: number;
    }
  ).id;
}

const COMPLETE: FileFields = { bpm: 120, label: "Apple", release_date: "1969-09-26", release_type: "album" };

/** A track on `album` by `artist`, with one file. */
function track(
  title: string,
  artist: number | null,
  album: number | null,
  fields: FileFields = {},
  mbid: string | null = "mb",
): number {
  const rec = node("recording", title, mbid == null ? null : `${mbid}-${title}`);
  db.prepare("INSERT INTO recordings (node_id) VALUES (?)").run(rec);
  if (artist != null) edge(rec, artist, "performed_by");
  if (album != null) edge(rec, album, "appears_on");
  file(rec, { ...COMPLETE, ...fields });
  return rec;
}

function play(recording: number, times = 1): void {
  const fileId = (db.prepare("SELECT id FROM files WHERE recording_node_id = ?").get(recording) as { id: number }).id;
  for (let i = 0; i < times; i++) {
    db.prepare(
      "INSERT INTO plays (recording_node_id, file_id, started_at, ms_played) VALUES (?, ?, datetime('now'), 60000)",
    ).run(recording, fileId);
  }
}

const DEFAULT: TagManagerField[] = ["unmatched", "label", "release_date", "release_type"];

describe("getGapCounts", () => {
  it("counts the tracks missing each kind, in one row", () => {
    const beatles = node("artist", "The Beatles");
    const abbey = node("release", "Abbey Road");
    track("Come Together", beatles, abbey, { label: null });
    track("Something", beatles, abbey, { label: null, bpm: null });
    track("Octopus's Garden", beatles, abbey, {}, null);
    track("Complete", beatles, abbey);

    expect(getGapCounts(db)).toEqual({ unmatched: 1, label: 2, release_date: 0, release_type: 0, bpm: 1 });
  });

  it("counts a track once however many of its files lack the field", () => {
    const rec = track("Merged", null, null, { label: null });
    file(rec, { ...COMPLETE, label: null });
    expect(getGapCounts(db).label).toBe(1);
  });

  it("leaves out files missing on disk, and recordings with no file", () => {
    track("Gone", null, null, { label: null, missing_since: "2026-01-01 00:00:00" });
    const orphan = node("recording", "No file");
    db.prepare("INSERT INTO recordings (node_id) VALUES (?)").run(orphan);
    expect(getGapCounts(db)).toEqual({ unmatched: 0, label: 0, release_date: 0, release_type: 0, bpm: 0 });
  });

  it("counts only an artist's tracks when there's a search", () => {
    const beatles = node("artist", "The Beatles");
    const stones = node("artist", "The Rolling Stones");
    track("A", beatles, null, { label: null });
    track("B", stones, null, { label: null });
    expect(getGapCounts(db, "beat").label).toBe(1);
    expect(getGapCounts(db, "THE").label).toBe(2);
  });

  it("answers zeros for an empty library", () => {
    expect(getGapCounts(db)).toEqual({ unmatched: 0, label: 0, release_date: 0, release_type: 0, bpm: 0 });
  });
});

describe("getGapAlbums", () => {
  it("groups gap tracks by album and sums each album's gaps", () => {
    const beatles = node("artist", "The Beatles");
    const abbey = node("release", "Abbey Road");
    track("Come Together", beatles, abbey, { label: null, release_date: null });
    track("Something", beatles, abbey, { label: null });
    track("Here Comes the Sun", beatles, abbey);

    const page = getGapAlbums(db, { kinds: DEFAULT }, "gaps", "desc", 0, 50);
    expect(page.total).toBe(1);
    expect(page.items).toEqual([
      {
        id: abbey,
        title: "Abbey Road",
        artist: "The Beatles",
        tracks: 2,
        gaps: 3,
        byKind: { unmatched: 0, label: 2, release_date: 1, release_type: 0 },
        plays: 0,
        releaseMbid: null,
      },
    ]);
  });

  it("leaves BPM out unless it's asked for", () => {
    const album = node("release", "Tempo");
    track("No BPM", null, album, { bpm: null });
    expect(getGapAlbums(db, { kinds: DEFAULT }, "gaps", "desc", 0, 50).items).toEqual([]);
    expect(getGapAlbums(db, { kinds: ["bpm"] }, "gaps", "desc", 0, 50).items).toHaveLength(1);
  });

  it("filters by kind: an album with only other gaps isn't listed", () => {
    const a = node("release", "Labelless");
    const b = node("release", "Undated");
    track("1", null, a, { label: null });
    track("2", null, b, { release_date: null });
    const page = getGapAlbums(db, { kinds: ["label"] }, "album", "asc", 0, 50);
    expect(page.items.map((x) => x.title)).toEqual(["Labelless"]);
    expect(page.items[0]!.byKind).toEqual({ label: 1 });
  });

  it("puts the tracks with no album in one group, last in every order", () => {
    const album = node("release", "Zzz");
    track("On an album", null, album, { label: null });
    track("Loose 1", null, null, { label: null });
    track("Loose 2", null, null, { label: null, release_date: null });

    for (const [sort, dir] of [
      ["gaps", "desc"],
      ["gaps", "asc"],
      ["album", "desc"],
      ["artist", "asc"],
      ["plays", "desc"],
    ] as const) {
      const ids = getGapAlbums(db, { kinds: DEFAULT }, sort, dir, 0, 50).items.map((x) => x.id);
      expect(ids).toEqual([album, null]);
    }
    const loose = getGapAlbums(db, { kinds: DEFAULT }, "gaps", "desc", 0, 50).items[1]!;
    expect(loose).toMatchObject({ title: null, artist: null, tracks: 2, gaps: 3 });
  });

  describe("sorting", () => {
    let small: number, big: number, played: number;
    beforeEach(() => {
      const zappa = node("artist", "Frank Zappa");
      const abba = node("artist", "ABBA");
      const bjork = node("artist", "björk");
      small = node("release", "Arrival");
      big = node("release", "Hot Rats");
      played = node("release", "Debut");
      track("Dancing Queen", abba, small, { label: null });
      track("Peaches en Regalia", zappa, big, { label: null, release_date: null });
      track("Willie the Pimp", zappa, big, { label: null, release_date: null });
      const human = track("Human Behaviour", bjork, played, { label: null });
      play(human, 5);
    });

    const order = (sort: "artist" | "album" | "gaps" | "plays", dir: "asc" | "desc") =>
      getGapAlbums(db, { kinds: DEFAULT }, sort, dir, 0, 50).items.map((x) => x.title);

    it("by artist, A–Z regardless of case, and back", () => {
      expect(order("artist", "asc")).toEqual(["Arrival", "Debut", "Hot Rats"]);
      expect(order("artist", "desc")).toEqual(["Hot Rats", "Debut", "Arrival"]);
    });

    it("by album", () => {
      expect(order("album", "asc")).toEqual(["Arrival", "Debut", "Hot Rats"]);
      expect(order("album", "desc")).toEqual(["Hot Rats", "Debut", "Arrival"]);
    });

    it("by number of gaps, ties by album", () => {
      expect(order("gaps", "desc")).toEqual(["Hot Rats", "Arrival", "Debut"]);
      expect(order("gaps", "asc")).toEqual(["Arrival", "Debut", "Hot Rats"]);
    });

    it("by plays", () => {
      expect(order("plays", "desc")).toEqual(["Debut", "Hot Rats", "Arrival"]);
      const debut = getGapAlbums(db, { kinds: DEFAULT }, "plays", "desc", 0, 1).items[0]!;
      expect(debut.plays).toBe(5);
    });
  });

  it("files an album under its primary artist when the albums table has one", () => {
    const various = node("artist", "Various Artists");
    const a = node("artist", "Alpha");
    const album = node("release", "Compilation");
    track("1", a, album, { label: null });
    db.prepare("INSERT INTO albums (node_id, primary_artist_node_id) VALUES (?, ?)").run(album, various);
    expect(getGapAlbums(db, { kinds: DEFAULT }, "gaps", "desc", 0, 50).items[0]!.artist).toBe("Various Artists");
  });

  it("filters by artist across any of a track's credits, with LIKE's wildcards taken literally", () => {
    const beatles = node("artist", "The Beatles");
    const preston = node("artist", "Billy Preston");
    const pct = node("artist", "100% Funk");
    const letItBe = node("release", "Let It Be");
    const other = node("release", "Other");
    const getBack = track("Get Back", beatles, letItBe, { label: null });
    edge(getBack, preston, "performed_by");
    track("Funky", pct, other, { label: null });

    const titles = (artist: string) =>
      getGapAlbums(db, { kinds: DEFAULT, artist }, "album", "asc", 0, 50).items.map((x) => x.title);
    expect(titles("preston")).toEqual(["Let It Be"]);
    expect(titles("%")).toEqual(["Other"]);
    expect(titles("nobody")).toEqual([]);
  });

  it("pages, with the total of every album however far in", () => {
    for (let i = 0; i < 5; i++) {
      const album = node("release", `Album ${i}`);
      track(`T${i}`, null, album, { label: null });
    }
    const first = getGapAlbums(db, { kinds: DEFAULT }, "album", "asc", 0, 2);
    const last = getGapAlbums(db, { kinds: DEFAULT }, "album", "asc", 4, 2);
    const beyond = getGapAlbums(db, { kinds: DEFAULT }, "album", "asc", 10, 2);
    expect(first).toMatchObject({ total: 5 });
    expect(first.items.map((x) => x.title)).toEqual(["Album 0", "Album 1"]);
    expect(last.items.map((x) => x.title)).toEqual(["Album 4"]);
    expect(beyond).toEqual({ total: 5, items: [] });
  });

  it("names the release MusicBrainz id from a tag before a match", () => {
    const tagged = node("release", "Tagged");
    const matched = node("release", "Matched");
    const neither = node("release", "Neither");
    track("1", null, tagged, {
      label: null,
      tags_raw: JSON.stringify({ mbReleaseId: "B84EE12A-09EF-421B-82DE-0441A926375B" }),
    });
    track("2", null, matched, { label: null, tags_raw: "not json" });
    track("3", null, neither, { label: null, tags_raw: JSON.stringify({ mbReleaseId: "not-an-mbid" }) });
    db.prepare(
      "INSERT INTO field_provenance (node_id, field, value, source, confidence) VALUES (?, 'release_mbid', ?, 'musicbrainz', 1)",
    ).run(matched, "f5093c06-23e3-404f-aeaa-40f72885ee3a");

    expect(releaseMbid(db, tagged)).toBe("b84ee12a-09ef-421b-82de-0441a926375b");
    expect(releaseMbid(db, matched)).toBe("f5093c06-23e3-404f-aeaa-40f72885ee3a");
    expect(releaseMbid(db, neither)).toBeNull();
  });

  it("groups a track on two albums under its first album only", () => {
    const first = node("release", "First");
    const second = node("release", "Second");
    const rec = track("Both", null, first, { label: null });
    edge(rec, second, "appears_on");
    const page = getGapAlbums(db, { kinds: DEFAULT }, "album", "asc", 0, 50);
    expect(page.items.map((x) => x.title)).toEqual(["First"]);
    expect(getGapTracks(db, second, { kinds: DEFAULT }, 0, 50).items).toEqual([]);
  });
});

describe("getGapTracks", () => {
  it("lists an album's gap tracks in disc and track order, with the files a value could go on", () => {
    const album = node("release", "Double");
    const d2t1 = track("Disc 2 opener", null, album, { label: null, disc_no: 2, track_no: 1 });
    const d1t2 = track("Second", null, album, { release_date: null, bpm: null, disc_no: 1, track_no: 2 });
    track("Fine", null, album, { disc_no: 1, track_no: 1 });
    const unmatched = track("Unmatched", null, album, { disc_no: 1, track_no: 3 }, null);

    const page = getGapTracks(db, album, { kinds: DEFAULT }, 0, 50);
    expect(page.total).toBe(3);
    expect(page.items.map((t) => t.id)).toEqual([d1t2, unmatched, d2t1]);
    const second = page.items[0]!;
    expect(second.missing).toEqual(["release_date"]);
    // BPM isn't asked for, so it isn't offered either.
    expect(second.files).toEqual([{ id: expect.any(Number), missing: ["release_date"] }]);
    expect(page.items[1]).toMatchObject({ missing: ["unmatched"], files: [] });
  });

  it("narrows an album's tracks to an artist's too", () => {
    const a = node("artist", "Alpha");
    const b = node("artist", "Beta");
    const album = node("release", "Split");
    const alpha = track("By Alpha", a, album, { label: null });
    track("By Beta", b, album, { label: null });
    expect(getGapTracks(db, album, { kinds: DEFAULT, artist: "alp" }, 0, 50).items.map((t) => t.id)).toEqual([alpha]);
    expect(getGapTracks(db, null, { kinds: DEFAULT, artist: "alp" }, 0, 50).items).toEqual([]);
  });

  it("lists the tracks with no album for 'none'", () => {
    const album = node("release", "An album");
    track("On it", null, album, { label: null });
    const loose = track("Loose", null, null, { label: null });
    expect(getGapTracks(db, null, { kinds: DEFAULT }, 0, 50).items.map((t) => t.id)).toEqual([loose]);
  });

  it("pages", () => {
    const album = node("release", "Long");
    for (let i = 1; i <= 5; i++) track(`T${i}`, null, album, { label: null, track_no: i });
    const page = getGapTracks(db, album, { kinds: DEFAULT }, 2, 2);
    expect(page.total).toBe(5);
    expect(page.items.map((t) => t.title)).toEqual(["T3", "T4"]);
  });

  it("offers each of a merged track's files that lacks the field, and not one that has it", () => {
    const album = node("release", "Merged");
    const rec = track("Two files", null, album, { label: null });
    const other = file(rec, { ...COMPLETE });
    const third = file(rec, { ...COMPLETE, label: null, missing_since: "2026-01-01 00:00:00" });
    const files = getGapTracks(db, album, { kinds: DEFAULT }, 0, 50).items[0]!.files;
    expect(files).toHaveLength(1);
    expect(files.map((f) => f.id)).not.toContain(other);
    expect(files.map((f) => f.id)).not.toContain(third);
  });
});

describe("getGapFiles", () => {
  it("returns every file on the album missing an album-level field, whatever kinds or artist the list shows", () => {
    const a = node("artist", "A");
    const b = node("artist", "B");
    const album = node("release", "Split");
    const one = track("1", a, album, { label: null });
    const two = track("2", b, album, { label: null, release_type: null });
    track("3", b, album, { bpm: null });
    track("Elsewhere", a, node("release", "Other"), { label: null });

    expect(getGapFiles(db, album)).toEqual([
      { id: expect.any(Number), trackId: one, missing: ["label"] },
      { id: expect.any(Number), trackId: two, missing: ["label", "release_type"] },
    ]);
  });
});

describe("parseKinds", () => {
  it("accepts a comma-separated list of known kinds, once each", () => {
    expect(parseKinds("label,release_date,label")).toEqual(["label", "release_date"]);
    expect(parseKinds("label,genre")).toBeNull();
    expect(parseKinds("")).toBeNull();
    expect(parseKinds(undefined)).toBeNull();
  });
});

describe("routes", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = Fastify();
    await app.register(tagManagerRoutes(db), { prefix: "/api/v1" });
  });
  const get = (url: string) => app.inject({ method: "GET", url: `/api/v1${url}` });

  it("GET /tag-manager/counts answers every kind", async () => {
    track("1", null, null, { label: null });
    expect((await get("/tag-manager/counts")).json()).toEqual({
      unmatched: 0,
      label: 1,
      release_date: 0,
      release_type: 0,
      bpm: 0,
    });
  });

  it("GET /tag-manager/albums pages, sorting by most gaps by default", async () => {
    const album = node("release", "A");
    track("1", null, album, { label: null });
    const res = await get("/tag-manager/albums?kinds=label,release_date&limit=10");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ total: 1, items: [{ id: album, gaps: 1 }] });
  });

  it("GET /tag-manager/albums refuses an unknown kind, sort or page size", async () => {
    expect((await get("/tag-manager/albums?kinds=genre")).statusCode).toBe(400);
    expect((await get("/tag-manager/albums")).statusCode).toBe(400);
    expect((await get("/tag-manager/albums?kinds=label&sort=year")).statusCode).toBe(400);
    expect((await get("/tag-manager/albums?kinds=label&dir=up")).statusCode).toBe(400);
    expect((await get("/tag-manager/albums?kinds=label&limit=1000")).statusCode).toBe(400);
    expect((await get("/tag-manager/albums?kinds=label&offset=-1")).statusCode).toBe(400);
  });

  it("GET /tag-manager/albums/:id/tracks takes a release id or none", async () => {
    const loose = track("Loose", null, null, { label: null });
    expect((await get("/tag-manager/albums/none/tracks?kinds=label")).json()).toMatchObject({
      total: 1,
      items: [{ id: loose }],
    });
    expect((await get("/tag-manager/albums/abc/tracks?kinds=label")).statusCode).toBe(400);
  });

  it("GET /tag-manager/albums/:id/files needs a release id", async () => {
    expect((await get("/tag-manager/albums/none/files")).statusCode).toBe(400);
    const album = node("release", "A");
    track("1", null, album, { label: null });
    expect((await get(`/tag-manager/albums/${album}/files`)).json()).toHaveLength(1);
  });
});
