import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { parseFile } from "music-metadata";
import type { Database } from "../sqlite.js";
import { openDb } from "../db.js";
import type { TagFields } from "../tagwrite/fields.js";
import { applyTagWrite } from "../tagwrite/writer.js";
import { runFfmpeg } from "../test-ffmpeg.js";

// Every fixture here is a copy of one sine tone, so with fpcalc installed
// the scan's AcoustID tier would fold them all into one recording, and
// enrich/worker.spec.ts's stub of this module, which outlives that file,
// does the same with any fingerprint it was last told to give. Without one,
// as on a machine with no fpcalc, each file stays its own track.
mock.module("../match/fingerprint.js", () => ({ computeFingerprint: async () => null }));
const { scanFile } = await import("../scan/scanner.js");
const { tagWritesRoutes } = await import("./tag-writes.js");
const { recompute } = await import("../recompute.js");

// Issue #464, end to end: real files scanned into a database, edited
// through the routes the details panel uses, written, and read back.

let templates: { flac: string; wav: string };
// Set before ffmpeg makes the templates in it, so afterAll removes it even
// when that fails, and doesn't fail again itself (#509).
let templateDir: string | undefined;
let db: Database;
let app: FastifyInstance;
let dir: string;
let rootId: number;

beforeAll(() => {
  const made = mkdtempSync(path.join(tmpdir(), "legato-tag-edit-templates-"));
  templateDir = made;
  const make = (name: string, extra: string[] = []) => {
    const out = path.join(made, name);
    runFfmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=0.2", ...extra, out]);
    return out;
  };
  templates = { flac: make("t.flac"), wav: make("t.wav") };
});

afterAll(() => {
  if (templateDir) rmSync(templateDir, { recursive: true, force: true });
});

beforeEach(async () => {
  db = openDb(":memory:");
  dir = mkdtempSync(path.join(tmpdir(), "legato-tag-edit-"));
  rootId = (db.prepare("INSERT INTO library_roots (path) VALUES (?) RETURNING id").get(dir) as { id: number }).id;
  app = Fastify();
  await app.register(tagWritesRoutes(db), { prefix: "/api/v1" });
});

afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

type Track = { fileId: number; recordingId: number; path: string };

// `name` can name a subfolder ("Queen/one"): #465 tells albums without an
// ALBUMARTIST apart by their folder.
async function addTrack(name: string, tags: TagFields): Promise<Track> {
  const file = path.join(dir, `${name}.flac`);
  mkdirSync(path.dirname(file), { recursive: true });
  copyFileSync(templates.flac, file);
  await applyTagWrite(file, tags);
  await scanFile(db, rootId, file);
  return trackAt(file);
}

// One after another, so the files' ids follow the list's order.
async function addTracks(count: number, tags: (n: number) => TagFields): Promise<Track[]> {
  const tracks: Track[] = [];
  for (let n = 1; n <= count; n++) tracks.push(await addTrack(`t${n}`, tags(n)));
  return tracks;
}

// A WAV the writer can't take, tagged through ffmpeg's RIFF INFO chunk.
async function addWav(name: string, tags: { title: string; artist: string; album: string }): Promise<Track> {
  const file = path.join(dir, `${name}.wav`);
  runFfmpeg(["-i", templates.wav, ...Object.entries(tags).flatMap(([k, v]) => ["-metadata", `${k}=${v}`]), "-c", "copy", file]);
  await scanFile(db, rootId, file);
  return trackAt(file);
}

function trackAt(file: string): Track {
  const row = db.prepare("SELECT id, recording_node_id FROM files WHERE file_path = ?").get(file) as {
    id: number;
    recording_node_id: number;
  };
  return { fileId: row.id, recordingId: row.recording_node_id, path: file };
}

// The node a recording's edge of this type points at.
function linked(recordingId: number, type: string): { id: number; title: string }[] {
  return db
    .prepare(
      `SELECT n.id, n.title FROM edges e JOIN nodes n ON n.id = e.to_node
        WHERE e.from_node = ? AND e.type = ? AND e.source = 'local' ORDER BY e.id`,
    )
    .all(recordingId, type) as { id: number; title: string }[];
}

function named(type: string, title: string): { id: number }[] {
  return db.prepare("SELECT id FROM nodes WHERE type = ? AND title = ?").all(type, title) as { id: number }[];
}

async function review(nodeId: number, changes: Record<string, unknown>) {
  const res = await app.inject({ method: "POST", url: "/api/v1/tag-writes", payload: { nodeId, changes } });
  return { status: res.statusCode, body: res.json() };
}

async function approve(editId: number) {
  const res = await app.inject({ method: "POST", url: `/api/v1/tag-writes/edits/${editId}/approve` });
  expect(res.statusCode).toBe(200);
  return res.json() as { written: number; failed: unknown[]; nodeId: number };
}

async function edit(nodeId: number, changes: Record<string, unknown>) {
  const { status, body } = await review(nodeId, changes);
  expect(status).toBe(200);
  return { review: body, approved: await approve(body.editId) };
}

function giveListenerThings(nodeId: number, otherId: number): void {
  db.prepare("INSERT INTO favourites (node_id) VALUES (?)").run(nodeId);
  db.prepare(
    "INSERT INTO positions (node_id, granularity, seed_x, seed_y, user_x, user_y) VALUES (?, 'albums', 1, 2, 50, 60)",
  ).run(nodeId);
  db.prepare("INSERT INTO descriptions (node_id, body, source) VALUES (?, 'About it.', 'wikipedia')").run(nodeId);
  db.prepare("INSERT INTO edges (from_node, to_node, type, source, label) VALUES (?, ?, 'personal', 'manual', 'led me to')").run(
    nodeId,
    otherId,
  );
  db.prepare("INSERT INTO cover_art (node_id, source, hash) VALUES (?, 'manual', 'chosen-cover')").run(nodeId);
}

function expectListenerThings(nodeId: number, otherId: number): void {
  expect(db.prepare("SELECT 1 FROM favourites WHERE node_id = ?").get(nodeId)).toBeTruthy();
  expect(db.prepare("SELECT user_x, user_y FROM positions WHERE node_id = ? AND granularity = 'albums'").get(nodeId)).toEqual({
    user_x: 50,
    user_y: 60,
  });
  expect(db.prepare("SELECT body FROM descriptions WHERE node_id = ?").get(nodeId)).toEqual({ body: "About it." });
  expect(
    db.prepare("SELECT 1 FROM edges WHERE from_node = ? AND to_node = ? AND source = 'manual'").get(nodeId, otherId),
  ).toBeTruthy();
  expect(db.prepare("SELECT hash FROM cover_art WHERE node_id = ? AND source = 'manual'").get(nodeId)).toEqual({
    hash: "chosen-cover",
  });
}

describe("editing a track", () => {
  it("writes every field, and the database says so without a rescan", async () => {
    const track = await addTrack("one", { title: "Old Title", artist: "Old Artist", album: "Old Album", trackNo: 1, releaseDate: "1999" });

    const { review: r, approved } = await edit(track.recordingId, {
      title: "Come Together",
      artist: "The Beatles",
      album: "Abbey Road",
      albumArtist: "The Beatles",
      releaseDate: "1969-09-26",
      trackNo: 3,
      discNo: 2,
      genre: ["Rock", "Pop"],
      bpm: 82,
      label: "Apple",
      releaseType: "album",
    });
    expect(r).toMatchObject({ noop: false, fileCount: 1, formats: ["FLAC"], skipped: [], merge: null });
    expect(approved).toMatchObject({ written: 1, failed: [] });

    const { common } = await parseFile(track.path);
    expect(common).toMatchObject({
      title: "Come Together",
      artist: "The Beatles",
      album: "Abbey Road",
      albumartist: "The Beatles",
      originaldate: "1969-09-26",
      track: { no: 3, of: null },
      disk: { no: 2, of: null },
      genre: ["Rock", "Pop"],
      bpm: 82,
      label: ["Apple"],
      releasetype: ["album"],
    });

    // The post-write refresh: the row, its tags and its edges, read back.
    expect(db.prepare("SELECT title FROM nodes WHERE id = ?").get(track.recordingId)).toEqual({ title: "Come Together" });
    const file = db
      .prepare("SELECT track_no, disc_no, release_date, bpm, label, release_type, genre, tags_raw FROM files WHERE id = ?")
      .get(track.fileId) as Record<string, unknown>;
    expect(file).toMatchObject({
      track_no: 3,
      disc_no: 2,
      release_date: "1969-09-26",
      bpm: 82,
      label: "Apple",
      release_type: "album",
      genre: JSON.stringify(["Rock", "Pop"]),
    });
    expect(JSON.parse(file.tags_raw as string).albumartist).toBe("The Beatles");
    expect(linked(track.recordingId, "performed_by").map((n) => n.title)).toEqual(["The Beatles"]);
    expect(linked(track.recordingId, "appears_on").map((n) => n.title)).toEqual(["Abbey Road"]);
    expect(linked(track.recordingId, "released_in").map((n) => n.title)).toEqual(["1969"]);
    expect(linked(track.recordingId, "released_on").map((n) => n.title)).toEqual(["Apple"]);

    // Search's index follows the title (0006's trigger).
    expect(db.prepare("SELECT rowid FROM nodes_fts WHERE nodes_fts MATCH 'together'").all()).toEqual([{ rowid: track.recordingId }]);

    const form = await app.inject({ method: "GET", url: `/api/v1/tag-writes/node/${track.recordingId}` });
    expect(form.json()).toEqual({
      type: "recording",
      values: {
        title: "Come Together",
        artist: "The Beatles",
        album: "Abbey Road",
        albumArtist: "The Beatles",
        releaseDate: "1969-09-26",
        trackNo: "3",
        discNo: "2",
        genre: "Rock; Pop",
        bpm: "82",
        label: "Apple",
        releaseType: "album",
      },
    });
  });

  it("is a no-op when the files already say it", async () => {
    const track = await addTrack("one", { title: "Same" });
    const { status, body } = await review(track.recordingId, { title: "Same" });
    expect(status).toBe(200);
    expect(body).toMatchObject({ noop: true, editId: null, writeIds: [] });
    expect(db.prepare("SELECT COUNT(*) AS n FROM tag_writes").get()).toEqual({ n: 0 });
  });

  it("refuses a field the kind of node doesn't edit, and a malformed value", async () => {
    const track = await addTrack("one", { title: "T", album: "A" });
    const releaseId = linked(track.recordingId, "appears_on")[0]!.id;
    expect((await review(releaseId, { title: "x" })).status).toBe(400);
    expect((await review(track.recordingId, { releaseDate: "26/09/1969" })).status).toBe(400);
    expect((await review(track.recordingId, { trackNo: 0 })).status).toBe(400);
    expect((await review(track.recordingId, { title: "  " })).status).toBe(400);
    expect((await review(track.recordingId, {})).status).toBe(400);
  });

  // Issue #323: the write is derived as it's read back (tagwrite/refresh.ts),
  // and the recompute after it derives the files beside it, whose album the
  // write can move too.
  it("moves the files beside it when its new number splits their folder into two artists' albums", async () => {
    const tracks = await addTracks(4, (n) => ({ title: `Song ${n}`, artist: n <= 2 ? "Pearl" : "Quartz", album: "Greatest Hits", trackNo: n }));
    recompute(db);
    const albumOf = (track: Track) => linked(track.recordingId, "appears_on")[0]!.id;
    expect(new Set(tracks.map(albumOf)).size).toBe(1);

    await edit(tracks[2]!.recordingId, { trackNo: 1 });
    recompute(db);

    const [pearl1, pearl2, quartz3, quartz4] = tracks.map(albumOf);
    expect(pearl1).toBe(pearl2!);
    expect(quartz3).toBe(quartz4!);
    expect(pearl1).not.toBe(quartz3!);
  });
});

describe("editing an album", () => {
  it("writes every file on it, and the renamed node keeps what the listener gave it", async () => {
    const tracks = await addTracks(3, (n) => ({ title: `Song ${n}`, artist: "The Beatles", album: "Abbey Rd", trackNo: n }));
    const albumId = linked(tracks[0]!.recordingId, "appears_on")[0]!.id;
    const other = db.prepare("INSERT INTO nodes (type, title) VALUES ('artist', 'Elsewhere') RETURNING id").get() as { id: number };
    giveListenerThings(albumId, other.id);

    const { review: r, approved } = await edit(albumId, {
      album: "Abbey Road",
      albumArtist: "The Beatles",
      releaseDate: "1969-09-26",
      genre: ["Rock"],
      label: "Apple",
      releaseType: "album",
    });
    expect(r).toMatchObject({ fileCount: 3, merge: null, skipped: [] });
    expect(approved).toEqual({ written: 3, failed: [], nodeId: albumId });

    for (const track of tracks) {
      const { common } = await parseFile(track.path);
      expect(common).toMatchObject({ album: "Abbey Road", albumartist: "The Beatles", originaldate: "1969-09-26", label: ["Apple"] });
      expect(linked(track.recordingId, "appears_on")).toEqual([{ id: albumId, title: "Abbey Road" }]);
    }
    expect(named("release", "Abbey Rd")).toEqual([]);
    expectListenerThings(albumId, other.id);
  });

  it("merges into the album already called that by the same album artist, and says so first", async () => {
    const first = await addTrack("a", { title: "One", artist: "Queen", album: "Greatest Hits I" });
    const second = await addTrack("b", { title: "Two", artist: "Queen", album: "Greatest Hits" });
    const renamed = linked(first.recordingId, "appears_on")[0]!.id;
    const existing = linked(second.recordingId, "appears_on")[0]!.id;
    const other = db.prepare("INSERT INTO nodes (type, title) VALUES ('artist', 'Elsewhere') RETURNING id").get() as { id: number };
    giveListenerThings(renamed, other.id);

    const { review: r, approved } = await edit(renamed, { album: "Greatest Hits" });
    expect(r.merge).toEqual({ id: existing, title: "Greatest Hits" });
    expect(approved.nodeId).toBe(existing);

    expect(db.prepare("SELECT 1 FROM nodes WHERE id = ?").get(renamed)).toBeFalsy();
    expect(linked(first.recordingId, "appears_on")).toEqual([{ id: existing, title: "Greatest Hits" }]);
    expectListenerThings(existing, other.id);
  });

  // Album identity is title and album artist (#465): one artist's Greatest
  // Hits never merges into another's.
  // #465's album identity, asked through findRelease: an album with an
  // ALBUMARTIST is that artist's, so another artist's same title is another
  // album, even in the same folder. The review says so, and approving and
  // the scanner afterwards keep them apart.
  it("doesn't merge into another artist's album of the same title, and the scanner keeps them apart", async () => {
    const queen = await addTrack("a", { title: "One", artist: "Queen", albumArtist: "Queen", album: "Greatest Hits I" });
    const abba = await addTrack("b", { title: "Two", artist: "ABBA", albumArtist: "ABBA", album: "Greatest Hits" });
    const queenAlbum = linked(queen.recordingId, "appears_on")[0]!.id;
    const abbaAlbum = linked(abba.recordingId, "appears_on")[0]!.id;
    db.prepare("INSERT INTO favourites (node_id) VALUES (?)").run(queenAlbum);

    const { review: r, approved } = await edit(queenAlbum, { album: "Greatest Hits" });
    expect(r.merge).toBeNull();
    expect(approved.nodeId).toBe(queenAlbum);
    expect(linked(queen.recordingId, "appears_on")).toEqual([{ id: queenAlbum, title: "Greatest Hits" }]);
    expect(linked(abba.recordingId, "appears_on")).toEqual([{ id: abbaAlbum, title: "Greatest Hits" }]);

    // The scanner, re-deriving from scratch, finds the same two albums.
    recompute(db);
    expect(linked(queen.recordingId, "appears_on")).toEqual([{ id: queenAlbum, title: "Greatest Hits" }]);
    expect(linked(abba.recordingId, "appears_on")).toEqual([{ id: abbaAlbum, title: "Greatest Hits" }]);
    expect(db.prepare("SELECT 1 FROM favourites WHERE node_id = ?").get(queenAlbum)).toBeTruthy();
  });

  // Without ALBUMARTIST, #465 takes an album's artist from its files' ARTIST
  // when they agree, so one artist's album of a title is one album wherever
  // its files are, and two artists' are two.
  it("merges one artist's same-titled albums without an album artist in different folders", async () => {
    const one = await addTrack("Live/one", { title: "One", artist: "Low", album: "Live" });
    const two = await addTrack("Live at Glastonbury/two", { title: "Two", artist: "Low", album: "Live at Glastonbury" });
    const renamed = linked(two.recordingId, "appears_on")[0]!.id;
    const other = linked(one.recordingId, "appears_on")[0]!.id;

    const { review: r } = await edit(renamed, { album: "Live" });
    expect(r.merge).toEqual({ id: other, title: "Live" });
    recompute(db);
    expect(linked(two.recordingId, "appears_on")).toEqual([{ id: other, title: "Live" }]);
    expect(linked(one.recordingId, "appears_on")).toEqual([{ id: other, title: "Live" }]);
  });

  it("doesn't merge two artists' same-titled albums without an album artist in different folders", async () => {
    const one = await addTrack("Live/one", { title: "One", artist: "Low", album: "Live" });
    const two = await addTrack("Live at Glastonbury/two", { title: "Two", artist: "Yo La Tengo", album: "Live at Glastonbury" });
    const renamed = linked(two.recordingId, "appears_on")[0]!.id;
    const other = linked(one.recordingId, "appears_on")[0]!.id;

    const { review: r } = await edit(renamed, { album: "Live" });
    expect(r.merge).toBeNull();
    recompute(db);
    expect(linked(two.recordingId, "appears_on")).toEqual([{ id: renamed, title: "Live" }]);
    expect(linked(one.recordingId, "appears_on")).toEqual([{ id: other, title: "Live" }]);
  });

  it("keeps each file's disc suffix when the album is retitled", async () => {
    const discs = [1, 2].map((n) => `Farewells & Fantasies (disc ${n})`);
    const one = await addTrack("one", { title: "One", artist: "Phil Ochs", album: discs[0] });
    const two = await addTrack("two", { title: "Two", artist: "Phil Ochs", album: discs[1] });
    const albumId = linked(one.recordingId, "appears_on")[0]!.id;
    expect(linked(two.recordingId, "appears_on")[0]!.id).toBe(albumId);

    await edit(albumId, { album: "Farewells and Fantasies" });
    expect((await parseFile(one.path)).common.album).toBe("Farewells and Fantasies (disc 1)");
    expect((await parseFile(two.path)).common.album).toBe("Farewells and Fantasies (disc 2)");
    for (const track of [one, two]) expect(linked(track.recordingId, "appears_on")).toEqual([{ id: albumId, title: "Farewells and Fantasies" }]);
    expect(db.prepare("SELECT disc_no FROM files WHERE id = ?").get(two.fileId)).toEqual({ disc_no: 2 });
  });

  it("skips the files the writer can't write, names them, and writes the rest", async () => {
    const flac = await addTrack("a", { title: "One", artist: "Low", album: "Things We Lost" });
    const wav = await addWav("b", { title: "Two", artist: "Low", album: "Things We Lost" });
    const albumId = linked(flac.recordingId, "appears_on")[0]!.id;
    expect(linked(wav.recordingId, "appears_on")[0]!.id).toBe(albumId);

    const { review: r, approved } = await edit(albumId, { album: "Things We Lost in the Fire" });
    expect(r.fileCount).toBe(1);
    expect(r.skipped).toEqual([
      { fileId: wav.fileId, path: wav.path, reason: "Legato can't write tags to WAV files yet, only FLAC, MP3 and M4A" },
    ]);
    expect(approved.written).toBe(1);

    expect((await parseFile(flac.path)).common.album).toBe("Things We Lost in the Fire");
    expect(linked(flac.recordingId, "appears_on")).toEqual([{ id: albumId, title: "Things We Lost in the Fire" }]);
    // The WAV still says the old title, and its old keys (#465's
    // release_keys) still lead to the album, so it stays on it.
    expect(linked(wav.recordingId, "appears_on")).toEqual([{ id: albumId, title: "Things We Lost in the Fire" }]);
  });
});

describe("renaming an artist", () => {
  it("changes only that artist's part of a multi-artist line, on every file they're credited on", async () => {
    const duo = await addTrack("a", { title: "One", artist: "JPEGMAFIA; Danny Brown" });
    const solo = await addTrack("b", { title: "Two", artist: "Danny Brown" });
    const guest = await addTrack("c", { title: "Three", artist: "Gorillaz feat. Danny Brown" });
    const unrelated = await addTrack("d", { title: "Four", artist: "JPEGMAFIA" });
    const danny = linked(solo.recordingId, "performed_by")[0]!.id;
    const peggy = linked(unrelated.recordingId, "performed_by")[0]!.id;
    db.prepare("INSERT INTO favourites (node_id) VALUES (?)").run(danny);

    const { review: r, approved } = await edit(danny, { name: "Danny B." });
    expect(r).toMatchObject({ fileCount: 3, merge: null });
    expect(approved).toEqual({ written: 3, failed: [], nodeId: danny });

    expect((await parseFile(duo.path)).common.artist).toBe("JPEGMAFIA; Danny B.");
    expect((await parseFile(solo.path)).common.artist).toBe("Danny B.");
    expect((await parseFile(guest.path)).common.artist).toBe("Gorillaz feat. Danny B.");
    expect((await parseFile(unrelated.path)).common.artist).toBe("JPEGMAFIA");

    expect(linked(duo.recordingId, "performed_by")).toEqual([
      { id: peggy, title: "JPEGMAFIA" },
      { id: danny, title: "Danny B." },
    ]);
    expect(linked(guest.recordingId, "performed_by").map((n) => n.id)).toContain(danny);
    expect(named("artist", "Danny Brown")).toEqual([]);
    expect(db.prepare("SELECT 1 FROM favourites WHERE node_id = ?").get(danny)).toBeTruthy();
  });

  it("leaves files that only have the name inside another one", async () => {
    const low = await addTrack("a", { title: "Sunflower", artist: "Low" });
    const other = await addTrack("b", { title: "Below Low Tide", artist: "Lower Dens" });
    const lowId = linked(low.recordingId, "performed_by")[0]!.id;

    const { review: r } = await edit(lowId, { name: "LOW" });
    expect(r.fileCount).toBe(1);
    expect((await parseFile(low.path)).common.artist).toBe("LOW");
    expect((await parseFile(other.path)).common).toMatchObject({ title: "Below Low Tide", artist: "Lower Dens" });
  });

  it("merges into the artist already called that", async () => {
    const a = await addTrack("a", { title: "One", artist: "Beetles" });
    const b = await addTrack("b", { title: "Two", artist: "The Beatles" });
    const renamed = linked(a.recordingId, "performed_by")[0]!.id;
    const existing = linked(b.recordingId, "performed_by")[0]!.id;
    expect(renamed).not.toBe(existing);
    db.prepare("INSERT INTO favourites (node_id) VALUES (?)").run(renamed);

    const { review: r, approved } = await edit(renamed, { name: "The Beatles" });
    expect(r.merge).toEqual({ id: existing, title: "The Beatles" });
    expect(approved.nodeId).toBe(existing);
    expect(linked(a.recordingId, "performed_by")).toEqual([{ id: existing, title: "The Beatles" }]);
    expect(db.prepare("SELECT 1 FROM nodes WHERE id = ?").get(renamed)).toBeFalsy();
    expect(db.prepare("SELECT 1 FROM favourites WHERE node_id = ?").get(existing)).toBeTruthy();
  });

  // #466's lookup: a leading "The" doesn't make two artists, so a rename
  // that differs from an existing artist only by it merges, as the scanner
  // would put the files there anyway. Unless their MusicBrainz ids differ.
  it("merges into the artist whose name differs only by a leading 'The', unless their ids differ", async () => {
    const a = await addTrack("a", { title: "One", artist: "Wilburys" });
    const b = await addTrack("b", { title: "Two", artist: "The Traveling Wilburys" });
    const renamed = linked(a.recordingId, "performed_by")[0]!.id;
    const existing = linked(b.recordingId, "performed_by")[0]!.id;

    const remember = (nodeId: number, mbid: string) =>
      db
        .prepare("INSERT INTO field_provenance (node_id, field, value, source, confidence) VALUES (?, 'artist_mbid', ?, 'musicbrainz', 1)")
        .run(nodeId, mbid);
    remember(renamed, "mbid-one");
    remember(existing, "mbid-two");
    expect((await review(renamed, { name: "Traveling Wilburys" })).body.merge).toBeNull();
    await app.inject({ method: "DELETE", url: "/api/v1/tag-writes/edits/1" });

    db.prepare("DELETE FROM field_provenance WHERE node_id = ?").run(existing);
    const { review: r, approved } = await edit(renamed, { name: "Traveling Wilburys" });
    expect(r.merge).toEqual({ id: existing, title: "The Traveling Wilburys" });
    expect(approved.nodeId).toBe(existing);
    expect(linked(a.recordingId, "performed_by")).toEqual([{ id: existing, title: "The Traveling Wilburys" }]);
  });
});

describe("reviewing and reverting", () => {
  it("leaves nothing written until it's approved, and a discarded edit leaves no rows", async () => {
    const track = await addTrack("a", { title: "Old" });
    const { body } = await review(track.recordingId, { title: "New" });
    expect((await parseFile(track.path)).common.title).toBe("Old");
    const discard = await app.inject({ method: "DELETE", url: `/api/v1/tag-writes/edits/${body.editId}` });
    expect(discard.statusCode).toBe(204);
    expect(db.prepare("SELECT COUNT(*) AS n FROM tag_writes").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM tag_edits").get()).toEqual({ n: 0 });
  });

  it("reverts a rename file by file, and the last one puts the node's name back", async () => {
    const tracks = await addTracks(2, (n) => ({ title: `S${n}`, artist: "Low", album: "Old Name", trackNo: n }));
    const albumId = linked(tracks[0]!.recordingId, "appears_on")[0]!.id;
    db.prepare("INSERT INTO favourites (node_id) VALUES (?)").run(albumId);
    const { review: r } = await edit(albumId, { album: "New Name" });
    const newKeys = () =>
      db.prepare(`SELECT COUNT(*) AS n FROM release_keys WHERE node_id = ? AND key LIKE '%"new name"%'`).get(albumId) as { n: number };
    expect(newKeys().n).toBeGreaterThan(0);

    const revert = (id: number) => app.inject({ method: "POST", url: `/api/v1/tag-writes/${id}/revert` });
    expect((await revert(r.writeIds[0])).statusCode).toBe(200);
    // Half reverted: both files are still on the album, the reverted one
    // found by its old keys (#465's release_keys), and it keeps the new
    // name while a file still says it.
    for (const track of tracks) expect(linked(track.recordingId, "appears_on")).toEqual([{ id: albumId, title: "New Name" }]);

    expect((await revert(r.writeIds[1])).statusCode).toBe(200);
    for (const track of tracks) {
      expect((await parseFile(track.path)).common.album).toBe("Old Name");
      expect(linked(track.recordingId, "appears_on")).toEqual([{ id: albumId, title: "Old Name" }]);
    }
    expect(named("release", "Old Name")).toEqual([{ id: albumId }]);
    expect(db.prepare("SELECT 1 FROM favourites WHERE node_id = ?").get(albumId)).toBeTruthy();
    // The keys the rename added are gone, so a file that says "New Name"
    // later is a new album, as it was before the edit.
    expect(newKeys().n).toBe(0);
  });

  // The bug #464 reported: the watcher skips Legato's own writes, so the
  // database kept the old values until a full scan. A single-file write,
  // as Library health's gap fixes make, is read back the same way.
  it("reads a single file's approved write back into the database", async () => {
    const track = await addTrack("a", { title: "T", album: "A" });
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/tag-writes",
      payload: { fileId: track.fileId, changes: { label: "Apple", releaseDate: "1970" } },
    });
    const id = created.json().id as number;
    await app.inject({ method: "POST", url: `/api/v1/tag-writes/${id}/approve` });
    expect(db.prepare("SELECT label, release_date FROM files WHERE id = ?").get(track.fileId)).toEqual({
      label: "Apple",
      release_date: "1970",
    });
    expect(linked(track.recordingId, "released_on").map((n) => n.title)).toEqual(["Apple"]);

    await app.inject({ method: "POST", url: `/api/v1/tag-writes/${id}/revert` });
    expect(db.prepare("SELECT label FROM files WHERE id = ?").get(track.fileId)).toEqual({ label: null });
    expect(linked(track.recordingId, "released_on")).toEqual([]);
  });

  it("carries the node over when Library health approves an edit's writes one at a time", async () => {
    const tracks = await addTracks(2, (n) => ({ title: `S${n}`, artist: "Low" }));
    const low = linked(tracks[0]!.recordingId, "performed_by")[0]!.id;
    const { body } = await review(low, { name: "LOW" });
    for (const id of body.writeIds) {
      const res = await app.inject({ method: "POST", url: `/api/v1/tag-writes/${id}/approve` });
      expect(res.json()).toMatchObject({ status: "written", edit_id: body.editId });
    }
    for (const track of tracks) expect(linked(track.recordingId, "performed_by")).toEqual([{ id: low, title: "LOW" }]);
  });
});
