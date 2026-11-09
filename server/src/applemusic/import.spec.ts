import { beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import type { Database } from "../sqlite.js";
import { openDb } from "../db.js";
import { installAuthGate } from "../auth/gate.js";
import { createSession } from "../auth/sessions.js";
import { createOwnerForTest } from "../auth/test-app.js";
import { authRoutes } from "../routes/auth.js";
import { appleMusicImportRoutes } from "../routes/apple-music-import.js";
import { getImportReport } from "../routes/playlist-import.js";
import { CLOUD_REASON, importAppleMusicLibrary, previewAppleMusicImport } from "./import.js";

// Against fixtures/Library.xml (see library.spec.ts): a trimmed library in
// the plist Music writes, every name and path in it made up.
const FIXTURE = readFileSync(path.join(import.meta.dir, "fixtures", "Library.xml"), "utf8");
const MEDIA = "/Volumes/Archive/Music Media/Music";

let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
});

// A scanned track: a recording, its file and its artist, as the M3U
// import's spec builds one.
function track(filePath: string, title: string, artist: string, durationMs: number): { node: number; file: number } {
  const root =
    (db.prepare("SELECT id FROM library_roots LIMIT 1").get() as { id: number } | undefined)?.id ??
    (db.prepare("INSERT INTO library_roots (path) VALUES ('/') RETURNING id").get() as { id: number }).id;
  const node = (
    db.prepare("INSERT INTO nodes (type, title) VALUES ('recording', ?) RETURNING id").get(title) as { id: number }
  ).id;
  db.prepare("INSERT INTO recordings (node_id, canonical_duration_ms) VALUES (?, ?)").run(node, durationMs);
  const file = (
    db
      .prepare(
        `INSERT INTO files (recording_node_id, library_root_id, file_path, file_mtime, file_size, duration_ms)
         VALUES (?, ?, ?, datetime('now'), 0, ?) RETURNING id`,
      )
      .get(node, root, filePath, durationMs) as { id: number }
  ).id;
  const artistId =
    (db.prepare("SELECT id FROM nodes WHERE type = 'artist' AND title = ?").get(artist) as { id: number } | undefined)
      ?.id ??
    (db.prepare("INSERT INTO nodes (type, title) VALUES ('artist', ?) RETURNING id").get(artist) as { id: number }).id;
  db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'performed_by', 'local')").run(
    node,
    artistId,
  );
  return { node, file };
}

// Legato on the Mac Music wrote the library on, scanning the same media
// folder, plus a folder of rips holding two tracks Music has elsewhere or
// only in the cloud.
function macLibrary(base = MEDIA) {
  return {
    lanterns: track(
      `${base}/The Paper Boats/Harbour Songs/01 Lanterns on the Water.m4a`,
      "Lanterns on the Water",
      "The Paper Boats",
      241066,
    ),
    salt: track(`${base}/The Paper Boats/Harbour Songs/02 Salt & Cedar.m4a`, "Salt & Cedar", "The Paper Boats", 213400),
    // Stored composed; Music's URL has the decomposed é.
    cafe: track(`${base}/Mira Okafor/Northern Rooms/03 Café Aurore.m4a`, "Café Aurore", "Mira Okafor", 287920),
    lowTide: track(`${base}/The Paper Boats/Harbour Songs/03 Low Tide.m4a`, "Low Tide", "The Paper Boats", 262133),
    // Converted and renamed: no path in common, but the same artist, title
    // and a length within 2 s.
    quiet: track(
      "/Volumes/Archive/Rips/Mira Okafor/Northern Rooms/04 - Quiet Engine.flac",
      "Quiet Engine",
      "Mira Okafor",
      198200,
    ),
    // Apple Music has it only in the cloud; Legato has a rip.
    velvet: track(
      "/Volumes/Archive/Rips/Northbound Signal/Static Bloom/03 Velvet Static.flac",
      "velvet static",
      "NORTHBOUND SIGNAL",
      276000,
    ),
  };
}

function importedPlays(): { file_id: number; play_count: number; started_at: string }[] {
  return db
    .prepare("SELECT file_id, play_count, started_at FROM plays WHERE source = 'apple-music' ORDER BY file_id")
    .all() as { file_id: number; play_count: number; started_at: string }[];
}

describe("matching the fixture to a scanned library", () => {
  it("matches by location, accents and & included, then by artist, title and length", () => {
    macLibrary();
    expect(previewAppleMusicImport(db, FIXTURE)).toEqual({
      tracks: 9,
      matchedByLocation: 4,
      matchedByMetadata: 2,
      notFound: 1,
      cloudOnly: 2,
      setAside: 3,
      remaps: [],
      plays: { tracks: 5, total: 12 + 3 + 7 + 2 + 4 },
      ratings: 2,
      datesAdded: 6,
      playlists: [
        { name: "Road Trip", tracks: 4, matched: 2, status: "new" },
        { name: "Sunday Morning & Coffee", tracks: 5, matched: 3, status: "new" },
        { name: "Empty Ideas", tracks: 0, matched: 0, status: "new" },
      ],
      skippedPlaylists: { smart: 1, builtIn: 4, folders: 1 },
    });
  });

  it("finds a library copied under another folder, as on a NAS, by its paths", () => {
    macLibrary("/mnt/music");
    const preview = previewAppleMusicImport(db, FIXTURE);
    expect(preview.remaps).toEqual([{ from: `${MEDIA}/`, to: "/mnt/music/", tracks: 4 }]);
    expect(preview).toMatchObject({ matchedByLocation: 4, matchedByMetadata: 2, notFound: 1, cloudOnly: 2 });
  });

  it("doesn't read a single coincidence as a moved library", () => {
    // One file that happens to end in the same three segments, and nothing
    // else under that folder.
    track(
      "/srv/other/The Paper Boats/Harbour Songs/01 Lanterns on the Water.m4a",
      "Lanterns on the Water",
      "The Paper Boats",
      241066,
    );
    const preview = previewAppleMusicImport(db, FIXTURE);
    expect(preview.remaps).toEqual([{ from: `${MEDIA}/`, to: "/srv/other/", tracks: 1 }]);
    // Which is a real match: the same file in the same Artist/Album layout.
    expect(preview.matchedByLocation).toBe(1);
  });

  it("leaves everything unmatched in an empty library, and says what's in the cloud", () => {
    const preview = previewAppleMusicImport(db, FIXTURE);
    expect(preview).toMatchObject({
      matchedByLocation: 0,
      matchedByMetadata: 0,
      notFound: 6,
      cloudOnly: 3,
      plays: { tracks: 0, total: 0 },
    });
  });
});

describe("importAppleMusicLibrary", () => {
  it("stores each matched track's play count as one total, with Music's last play date", () => {
    const lib = macLibrary();
    importAppleMusicLibrary(db, "Library.xml", FIXTURE);
    expect(importedPlays()).toEqual(
      [
        { file_id: lib.lanterns.file, play_count: 12, started_at: "2025-10-28T20:14:03Z" },
        // Music has a count for it but no date.
        { file_id: lib.salt.file, play_count: 3, started_at: "" },
        { file_id: lib.cafe.file, play_count: 7, started_at: "2025-10-20T13:16:51Z" },
        { file_id: lib.quiet.file, play_count: 2, started_at: "2024-10-17T07:33:20Z" },
        { file_id: lib.velvet.file, play_count: 4, started_at: "2025-09-19T06:41:50Z" },
      ].sort((a, b) => a.file_id - b.file_id),
    );
    // Never played in Music: no row at all.
    expect(importedPlays().some((p) => p.file_id === lib.lowTide.file)).toBe(false);
  });

  it("keeps ratings set on a track and every date added, by file", () => {
    const lib = macLibrary();
    importAppleMusicLibrary(db, "Library.xml", FIXTURE);
    const facts = db
      .prepare(
        "SELECT file_id, rating, date_added FROM imported_track_facts WHERE source = 'apple-music' ORDER BY file_id",
      )
      .all();
    expect(facts).toEqual(
      [
        { file_id: lib.lanterns.file, rating: 80, date_added: "2024-03-02T10:00:12Z" },
        { file_id: lib.salt.file, rating: 60, date_added: "2024-03-02T10:00:12Z" },
        // Its 100 was worked out from the album's rating.
        { file_id: lib.cafe.file, rating: null, date_added: "2023-01-15T21:31:40Z" },
        { file_id: lib.lowTide.file, rating: null, date_added: "2024-03-02T10:00:12Z" },
        { file_id: lib.quiet.file, rating: null, date_added: "2023-01-15T21:31:40Z" },
        { file_id: lib.velvet.file, rating: null, date_added: "2025-02-11T18:20:44Z" },
      ].sort((a, b) => a.file_id - b.file_id),
    );
  });

  it("makes the person's playlists, in order, each with its report", () => {
    const lib = macLibrary();
    const result = importAppleMusicLibrary(db, "Library.xml", FIXTURE);
    expect(result.playlists.map((p) => [p.name, p.status, p.playlistId != null])).toEqual([
      ["Road Trip", "new", true],
      ["Sunday Morning & Coffee", "new", true],
      ["Empty Ideas", "new", true],
    ]);
    const roadTrip = result.playlists[0]!.playlistId!;
    const nodes = db
      .prepare("SELECT node_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position")
      .all(roadTrip);
    expect(nodes).toEqual([{ node_id: lib.lanterns.node }, { node_id: lib.quiet.node }]);

    const report = getImportReport(db, roadTrip)!;
    expect(report.sourceFilename).toBe("Library.xml");
    expect(report.entries.map((e) => [e.extinfTitle, e.matchType, e.reason])).toEqual([
      ["Lanterns on the Water", "path", null],
      ["Quiet Engine", "metadata", null],
      ["Glass Harbour", "missing", CLOUD_REASON],
      ["Unheard Thing", "missing", "Not in Legato's library, by path or by artist, title and length"],
    ]);
    const sunday = getImportReport(db, result.playlists[1]!.playlistId!)!;
    expect(sunday.entries.at(-1)).toMatchObject({
      extinfTitle: "Lanterns on the Water (Live Video)",
      matchType: "missing",
      reason: "Not music Legato plays: a video, a podcast or a radio stream",
    });
  });

  it("lists the cloud-only tracks and the ones not found, by artist and album", () => {
    macLibrary();
    const result = importAppleMusicLibrary(db, "Library.xml", FIXTURE);
    expect(result.cloudOnlyTracks).toEqual([
      { name: "Paper Moon Waltz", artist: "Elsie Varga", album: "Ballroom Tapes", location: null },
      { name: "Glass Harbour", artist: "Northbound Signal", album: "Static Bloom", location: null },
    ]);
    expect(result.notFoundTracks).toEqual([
      {
        name: "Unheard Thing",
        artist: "Northbound Signal",
        album: "Static Bloom",
        location: `${MEDIA}/Northbound Signal/Static Bloom/01 Unheard Thing.mp3`,
      },
    ]);
  });

  it("replaces Music's totals on a second import, never adds to them, and leaves Legato's own plays alone", () => {
    const lib = macLibrary();
    db.prepare(
      "INSERT INTO plays (recording_node_id, file_id, started_at, ms_played) VALUES (?, ?, '2026-11-01T10:00:00Z', 200000)",
    ).run(lib.lanterns.node, lib.lanterns.file);
    importAppleMusicLibrary(db, "Library.xml", FIXTURE);
    importAppleMusicLibrary(db, "Library.xml", FIXTURE.replace("<integer>12</integer>", "<integer>15</integer>"));
    const total = (file: number) =>
      (db.prepare("SELECT SUM(play_count) AS n FROM plays WHERE file_id = ?").get(file) as { n: number }).n;
    expect(total(lib.lanterns.file)).toBe(15 + 1);
    expect(total(lib.cafe.file)).toBe(7);
    expect(db.prepare("SELECT COUNT(*) AS n FROM imported_track_facts").get()).toEqual({ n: 6 });
  });

  it("doesn't make a playlist twice, and makes it again once it's been deleted", () => {
    macLibrary();
    importAppleMusicLibrary(db, "Library.xml", FIXTURE);
    const count = () => (db.prepare("SELECT COUNT(*) AS n FROM playlists").get() as { n: number }).n;
    expect(count()).toBe(3);

    const again = importAppleMusicLibrary(db, "Library.xml", FIXTURE);
    expect(again.playlists.map((p) => [p.status, p.playlistId])).toEqual([
      ["already-imported", null],
      ["already-imported", null],
      ["already-imported", null],
    ]);
    expect(count()).toBe(3);

    db.prepare("DELETE FROM playlists WHERE name = 'Road Trip'").run();
    expect(previewAppleMusicImport(db, FIXTURE).playlists[0]!.status).toBe("new");
    importAppleMusicLibrary(db, "Library.xml", FIXTURE);
    expect(count()).toBe(3);
  });

  it("removing the folder a track was matched in takes its imported facts with it", () => {
    macLibrary();
    importAppleMusicLibrary(db, "Library.xml", FIXTURE);
    db.prepare("DELETE FROM plays").run();
    db.prepare("DELETE FROM files").run();
    expect(db.prepare("SELECT COUNT(*) AS n FROM imported_track_facts").get()).toEqual({ n: 0 });
  });
});

describe("POST /apple-music/import", () => {
  let app: FastifyInstance;
  let token: string;

  beforeEach(async () => {
    app = Fastify();
    await app.register(cookie);
    installAuthGate(app, db);
    await app.register(authRoutes(db), { prefix: "/api/v1" });
    await app.register(appleMusicImportRoutes(db), { prefix: "/api/v1" });
    await app.ready();
    token = (await createOwnerForTest(app)).token;
  });

  const post = (url: string, body: string, headers: Record<string, string> = {}) =>
    app.inject({
      method: "POST",
      url,
      payload: body,
      headers: { "content-type": "application/xml", authorization: `Bearer ${token}`, ...headers },
    });

  it("previews, then imports, the file sent as XML", async () => {
    macLibrary();
    const preview = await post("/api/v1/apple-music/import/preview", FIXTURE);
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ tracks: 9, cloudOnly: 2 });
    expect(importedPlays()).toEqual([]);

    const done = await post("/api/v1/apple-music/import?filename=Library.xml", FIXTURE, { "content-type": "text/xml" });
    expect(done.statusCode).toBe(200);
    expect(done.json().cloudOnlyTracks).toHaveLength(2);
    expect(importedPlays()).toHaveLength(5);
  });

  it("says what's wrong with a file that isn't a library", async () => {
    const res = await post("/api/v1/apple-music/import/preview", "#EXTM3U\n/music/a.flac");
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ reason: "not_a_library" });
    expect(res.json().error).toStartWith("This isn't a Library.xml Music could have written.");
  });

  it("is the owner's alone", async () => {
    const other = db
      .prepare(`INSERT INTO users (provider, provider_user_id, role) VALUES ('github', '42', 'legacy') RETURNING id`)
      .get() as { id: number };
    const session = createSession(db, other.id);
    const res = await post("/api/v1/apple-music/import", FIXTURE, { authorization: `Bearer ${session.token}` });
    expect(res.statusCode).toBe(403);
    expect(importedPlays()).toEqual([]);
  });
});
