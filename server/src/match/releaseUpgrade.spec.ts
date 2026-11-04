import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Database } from "../sqlite.js";
import { openDb } from "../db.js";
import { openDbAt } from "../testing.js";

// Real storeCover shells out to ffmpeg to make the cached sizes; this suite
// only cares which node a cover row lands on.
mock.module("../cover/store.js", () => ({ storeCover: mock().mockResolvedValue("folder-art-hash") }));

const { upgradeReleaseIdentities, attachUpgradedCovers } = await import("./releaseUpgrade.js");
const { deriveLocalEdges, NODE_LOOKUP_SQL } = await import("./edges.js");

// Issue #465: a library from before album identity, as the release before
// migration 0045 left it, opened by this one.

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "legato-release-upgrade-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

type Old = {
  db: Database;
  root: number;
  /** A file as the old scan and derive left it: its album node found by the
   *  ALBUM tag alone, and no disc number but a disc tag's. */
  file: (filePath: string, tags: Record<string, unknown>) => { fileId: number; recording: number; album: number };
};

function oldLibrary(write: (old: Old) => void): Database {
  const dbPath = path.join(dataDir, "legato.db");
  const db = openDbAt(dbPath, 44);
  const root = (db.prepare("INSERT INTO library_roots (path) VALUES ('/m') RETURNING id").get() as { id: number }).id;
  const file: Old["file"] = (filePath, tags) => {
    const recording = (
      db.prepare("INSERT INTO nodes (type, title) VALUES ('recording', ?) RETURNING id").get(filePath) as { id: number }
    ).id;
    db.prepare("INSERT INTO recordings (node_id) VALUES (?)").run(recording);
    const fileId = (
      db
        .prepare(
          `INSERT INTO files (recording_node_id, library_root_id, file_path, file_mtime, file_size, tags_raw, disc_no)
           VALUES (?, ?, ?, datetime('now'), 0, ?, ?) RETURNING id`,
        )
        .get(recording, root, filePath, JSON.stringify(tags), (tags.discNo as number | undefined) ?? null) as {
        id: number;
      }
    ).id;
    const title = tags.album as string;
    const album =
      (db.prepare(NODE_LOOKUP_SQL).get("release", title) as { id: number } | undefined)?.id ??
      (db.prepare("INSERT INTO nodes (type, title) VALUES ('release', ?) RETURNING id").get(title) as { id: number })
        .id;
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'appears_on', 'local')").run(
      recording,
      album,
    );
    return { fileId, recording, album };
  };
  write({ db, root, file });
  db.close();
  return openDb(dbPath, { log: () => {} });
}

function albumOf(db: Database, recording: number): number {
  return (
    db.prepare("SELECT to_node FROM edges WHERE from_node = ? AND type = 'appears_on'").get(recording) as {
      to_node: number;
    }
  ).to_node;
}

function title(db: Database, nodeId: number): string | undefined {
  return (db.prepare("SELECT title FROM nodes WHERE id = ?").get(nodeId) as { title: string } | undefined)?.title;
}

function releaseCount(db: Database): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE type = 'release'").get() as { n: number }).n;
}

describe("migration 0045", () => {
  it("owes the upgrade only to a library that already has albums", () => {
    const fresh = openDb(":memory:");
    expect(upgradeReleaseIdentities(fresh)).toBeNull();

    const db = oldLibrary(({ file }) => {
      file("/m/Neil Young/Harvest/01.flac", { album: "Harvest" });
    });
    expect(db.prepare("SELECT id FROM release_identity_upgrade").all()).toEqual([{ id: 1 }]);
    expect(upgradeReleaseIdentities(db)).not.toBeNull();
    expect(db.prepare("SELECT id FROM release_identity_upgrade").all()).toEqual([]);
    // Once only.
    expect(upgradeReleaseIdentities(db)).toBeNull();
  });
});

describe("upgradeReleaseIdentities: a set's discs", () => {
  it("merges the parts into the oldest, carrying a favourite, a dragged position, a chosen cover and a connection from any part", () => {
    let one = { fileId: 0, recording: 0, album: 0 };
    let two = { fileId: 0, recording: 0, album: 0 };
    let doors = 0;
    const db = oldLibrary(({ db, file }) => {
      one = file("/m/The Doors/Best Of/CD1/01.flac", {
        artist: "The Doors",
        album: "The Best Of The Doors [CD1]",
        trackNo: 1,
      });
      two = file("/m/The Doors/Best Of/CD2/01.flac", {
        artist: "The Doors",
        album: "The Best Of The Doors [CD2]",
        trackNo: 1,
      });
      doors = (
        db.prepare("INSERT INTO nodes (type, title) VALUES ('artist', 'The Doors') RETURNING id").get() as {
          id: number;
        }
      ).id;
      // Disc 1 is the favourite; disc 2 is where the user dragged the album,
      // chose its cover and drew a connection.
      db.prepare("INSERT INTO favourites (node_id) VALUES (?)").run(one.album);
      db.prepare("INSERT INTO positions (node_id, granularity, seed_x, seed_y) VALUES (?, 'albums', 0, 0)").run(
        one.album,
      );
      db.prepare(
        "INSERT INTO positions (node_id, granularity, seed_x, seed_y, user_x, user_y) VALUES (?, 'albums', 5, 5, 40, 50)",
      ).run(two.album);
      db.prepare("INSERT INTO cover_art (node_id, source, hash) VALUES (?, 'manual', 'chosen')").run(two.album);
      db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'related', 'manual')").run(
        two.album,
        doors,
      );
    });

    const result = upgradeReleaseIdentities(db)!;
    expect(result).toMatchObject({ merged: 1, split: 0, retitled: 1, discNumbers: 2, needCovers: [] });

    expect(albumOf(db, one.recording)).toBe(one.album);
    expect(albumOf(db, two.recording)).toBe(one.album);
    expect(title(db, one.album)).toBe("The Best Of The Doors");
    expect(title(db, two.album)).toBeUndefined();
    expect(db.prepare("SELECT node_id FROM favourites").all()).toEqual([{ node_id: one.album }]);
    expect(db.prepare("SELECT user_x, user_y FROM positions WHERE node_id = ?").get(one.album)).toEqual({
      user_x: 40,
      user_y: 50,
    });
    expect(db.prepare("SELECT node_id, hash FROM cover_art WHERE source = 'manual'").all()).toEqual([
      { node_id: one.album, hash: "chosen" },
    ]);
    expect(
      db.prepare("SELECT from_node, to_node FROM edges WHERE source = 'manual' AND type = 'related'").all(),
    ).toEqual([{ from_node: one.album, to_node: doors }]);
  });

  it("merges Amchitka's and Farewells & Fantasies' parts, and gives their files the disc the suffix names", () => {
    const files: { fileId: number; recording: number; album: number }[] = [];
    const db = oldLibrary(({ file }) => {
      files.push(
        file("/m/Various/Amchitka/101.flac", { album: "Amchitka-The 1970 Concert That Launched Greenpeace CD1" }),
      );
      files.push(
        file("/m/Various/Amchitka/201.flac", { album: "Amchitka-The 1970 Concert That Launched Greenpeace CD2" }),
      );
      for (const disc of [1, 2, 3]) {
        files.push(
          file(`/m/Phil Ochs/F&F/${disc}01.flac`, {
            albumartist: "Phil Ochs",
            album: `Farewells & Fantasies (disc ${disc})`,
          }),
        );
      }
      // A disc tag wins over the suffix.
      files.push(
        file("/m/Phil Ochs/F&F/302.flac", {
          albumartist: "Phil Ochs",
          album: "Farewells & Fantasies (disc 3)",
          discNo: 9,
        }),
      );
    });
    expect(releaseCount(db)).toBe(5);

    upgradeReleaseIdentities(db);

    expect(releaseCount(db)).toBe(2);
    expect(new Set(files.slice(0, 2).map((f) => albumOf(db, f.recording)))).toEqual(new Set([files[0]!.album]));
    expect(new Set(files.slice(2).map((f) => albumOf(db, f.recording)))).toEqual(new Set([files[2]!.album]));
    expect(title(db, files[0]!.album)).toBe("Amchitka-The 1970 Concert That Launched Greenpeace");
    expect(title(db, files[2]!.album)).toBe("Farewells & Fantasies");

    const discs = db
      .prepare("SELECT disc_no AS disc, json_extract(tags_raw, '$.discNo') AS tag FROM files ORDER BY id")
      .all();
    expect(discs).toEqual([
      { disc: 1, tag: 1 },
      { disc: 2, tag: 2 },
      { disc: 1, tag: 1 },
      { disc: 2, tag: 2 },
      { disc: 3, tag: 3 },
      { disc: 9, tag: 9 },
    ]);
  });

  it("leaves a set marker's title alone and merges nothing into it", () => {
    let wilburys = { fileId: 0, recording: 0, album: 0 };
    const db = oldLibrary(({ file }) => {
      wilburys = file("/m/Wilburys/Collection/01.flac", { album: "The Traveling Wilburys Collection [2CD]" });
      file("/m/Jackson Browne/The Pretender/01.flac", { album: "The Pretender [DCC GZS-1047]" });
    });
    expect(upgradeReleaseIdentities(db)).toMatchObject({ merged: 0, split: 0, retitled: 0, discNumbers: 0 });
    expect(title(db, wilburys.album)).toBe("The Traveling Wilburys Collection [2CD]");
  });
});

describe("upgradeReleaseIdentities: a node two albums shared", () => {
  it("stays with the album with more of its files; the other starts on a node of its own", () => {
    const queen: { fileId: number; recording: number; album: number }[] = [];
    const abba: { fileId: number; recording: number; album: number }[] = [];
    let shared = 0;
    const db = oldLibrary(({ db, file }) => {
      abba.push(file("/m/ABBA/Greatest Hits/01.flac", { artist: "ABBA", albumartist: "ABBA", album: "Greatest Hits" }));
      for (const n of [1, 2, 3]) {
        queen.push(
          file(`/m/Queen/Greatest Hits/0${n}.flac`, { artist: "Queen", albumartist: "Queen", album: "Greatest Hits" }),
        );
      }
      abba.push(file("/m/ABBA/Greatest Hits/02.flac", { artist: "ABBA", albumartist: "ABBA", album: "Greatest Hits" }));
      shared = queen[0]!.album;
      // ABBA's files came in a year ago.
      db.prepare("UPDATE files SET first_seen_at = '2025-11-01 10:00:00' WHERE id = ?").run(abba[0]!.fileId);
      db.prepare("UPDATE files SET first_seen_at = '2025-11-02 10:00:00' WHERE id = ?").run(abba[1]!.fileId);
      db.prepare("INSERT INTO favourites (node_id) VALUES (?)").run(shared);
      db.prepare("INSERT INTO cover_art (node_id, source, hash) VALUES (?, 'manual', 'chosen')").run(shared);
      // The embedded cover the shared node shows came from ABBA's file,
      // scanned last.
      db.prepare(
        "INSERT INTO cover_art (node_id, source, hash, origin_file_id) VALUES (?, 'embedded', 'abba-art', ?)",
      ).run(shared, abba[1]!.fileId);
    });

    const result = upgradeReleaseIdentities(db)!;
    expect(result).toMatchObject({ merged: 0, split: 1, retitled: 0 });

    for (const f of queen) expect(albumOf(db, f.recording)).toBe(shared);
    const abbaAlbum = albumOf(db, abba[0]!.recording);
    expect(abbaAlbum).not.toBe(shared);
    expect(albumOf(db, abba[1]!.recording)).toBe(abbaAlbum);
    expect(title(db, abbaAlbum)).toBe("Greatest Hits");
    // Added when its files were, not today: the Library sorts by it.
    expect(db.prepare("SELECT created_at FROM nodes WHERE id = ?").get(abbaAlbum)).toEqual({
      created_at: "2025-11-01 10:00:00",
    });

    // Queen's album keeps what was on the node; ABBA's takes only the art
    // its own file supplied.
    expect(db.prepare("SELECT node_id FROM favourites").all()).toEqual([{ node_id: shared }]);
    expect(db.prepare("SELECT node_id, source, hash FROM cover_art ORDER BY node_id, source").all()).toEqual([
      { node_id: shared, source: "manual", hash: "chosen" },
      { node_id: abbaAlbum, source: "embedded", hash: "abba-art" },
    ]);
    // Queen's album has no art of its own files left, so it's read again.
    expect(result.needCovers).toEqual([shared]);
  });

  it("on a tie, stays with the album whose first file came first", () => {
    let first = { fileId: 0, recording: 0, album: 0 };
    let second = { fileId: 0, recording: 0, album: 0 };
    const db = oldLibrary(({ file }) => {
      first = file("/m/ABBA/Gold/01.flac", { albumartist: "ABBA", album: "Gold" });
      second = file("/m/Spandau Ballet/Gold/01.flac", { albumartist: "Spandau Ballet", album: "Gold" });
    });
    upgradeReleaseIdentities(db);
    expect(albumOf(db, first.recording)).toBe(first.album);
    expect(albumOf(db, second.recording)).not.toBe(first.album);
  });

  it("splits by folder when the albums have no ALBUMARTIST, and keeps a compilation in one folder whole", () => {
    const files: { fileId: number; recording: number; album: number }[] = [];
    const db = oldLibrary(({ file }) => {
      files.push(file("/m/Queen/Greatest Hits/01.flac", { artist: "Queen", album: "Greatest Hits" }));
      files.push(file("/m/ABBA/Greatest Hits/01.flac", { artist: "ABBA", album: "Greatest Hits" }));
      files.push(file("/m/Compilations/Nuggets/01.flac", { artist: "The Byrds", album: "Nuggets" }));
      files.push(file("/m/Compilations/Nuggets/02.flac", { artist: "The Turtles", album: "Nuggets" }));
    });
    expect(upgradeReleaseIdentities(db)).toMatchObject({ split: 1 });
    expect(albumOf(db, files[0]!.recording)).toBe(files[0]!.album);
    expect(albumOf(db, files[1]!.recording)).not.toBe(files[0]!.album);
    expect(albumOf(db, files[3]!.recording)).toBe(albumOf(db, files[2]!.recording));
  });

  it("splits a node shared by disc parts of two artists' sets, and merges each set's parts", () => {
    const files: { fileId: number; recording: number; album: number }[] = [];
    const db = oldLibrary(({ file }) => {
      files.push(file("/m/Queen/GH/CD1/01.flac", { albumartist: "Queen", album: "Greatest Hits CD1" }));
      files.push(file("/m/Queen/GH/CD2/01.flac", { albumartist: "Queen", album: "Greatest Hits CD2" }));
      files.push(file("/m/ABBA/GH/01.flac", { albumartist: "ABBA", album: "Greatest Hits CD1" }));
      files.push(file("/m/ABBA/GH/02.flac", { albumartist: "ABBA", album: "Greatest Hits CD1" }));
    });
    // Old: "Greatest Hits CD1" (Queen 1 file, ABBA 2) and "… CD2" (Queen 1).
    const cd1 = files[0]!.album;
    const cd2 = files[1]!.album;
    upgradeReleaseIdentities(db);
    // ABBA has more of CD1's files and keeps it; Queen keeps CD2, now its
    // whole set.
    expect(albumOf(db, files[2]!.recording)).toBe(cd1);
    expect(albumOf(db, files[3]!.recording)).toBe(cd1);
    expect(albumOf(db, files[0]!.recording)).toBe(cd2);
    expect(albumOf(db, files[1]!.recording)).toBe(cd2);
    expect(title(db, cd1)).toBe("Greatest Hits");
    expect(title(db, cd2)).toBe("Greatest Hits");
  });
});

describe("after the upgrade", () => {
  it("derives every file onto the node the upgrade gave it, and makes no new albums", () => {
    const files: { fileId: number; recording: number; album: number }[] = [];
    const db = oldLibrary(({ file }) => {
      files.push(
        file("/m/The Doors/Best Of/CD1/01.flac", { artist: "The Doors", album: "The Best Of The Doors [CD1]" }),
      );
      files.push(
        file("/m/The Doors/Best Of/CD2/01.flac", { artist: "The Doors", album: "The Best Of The Doors [CD2]" }),
      );
      files.push(file("/m/Queen/Greatest Hits/01.flac", { albumartist: "Queen", album: "Greatest Hits" }));
      files.push(file("/m/ABBA/Greatest Hits/01.flac", { album: "Greatest Hits" }));
      files.push(file("/m/Wings/Band on the Run/01.flac", { albumartist: "Wings", album: "Band on the Run" }));
      files.push(file("/m/Wings/Band on the Run/02.flac", { album: "Band on the Run" }));
    });
    upgradeReleaseIdentities(db);
    const before = files.map((f) => albumOf(db, f.recording));
    const count = releaseCount(db);
    for (const f of [...files].reverse()) deriveLocalEdges(db, f.fileId);
    expect(files.map((f) => albumOf(db, f.recording))).toEqual(before);
    expect(releaseCount(db)).toBe(count);
    expect(before[0]).toBe(before[1]);
    expect(before[2]).not.toBe(before[3]);
    expect(before[4]).toBe(before[5]);
  });
});

// Issue #465's second pass: a library 0045's rule filed, where each file's
// ALBUMARTIST was decided alone, opened by the release with 0053.
describe("migration 0053", () => {
  type Filed = { fileId: number; recording: number };

  function filedLibrary(
    write: (old: {
      db: Database;
      album: (title: string, keys: string[]) => number;
      file: (filePath: string, album: number, tags: Record<string, unknown>) => Filed;
    }) => void,
  ): Database {
    const dbPath = path.join(dataDir, "legato.db");
    const db = openDbAt(dbPath, 52);
    const root = (db.prepare("INSERT INTO library_roots (path) VALUES ('/m') RETURNING id").get() as { id: number }).id;
    const album = (title: string, keys: string[]) => {
      const id = (
        db.prepare("INSERT INTO nodes (type, title) VALUES ('release', ?) RETURNING id").get(title) as { id: number }
      ).id;
      for (const key of keys) db.prepare("INSERT INTO release_keys (key, node_id) VALUES (?, ?)").run(key, id);
      return id;
    };
    const file = (filePath: string, albumId: number, tags: Record<string, unknown>) => {
      const recording = (
        db.prepare("INSERT INTO nodes (type, title) VALUES ('recording', ?) RETURNING id").get(filePath) as {
          id: number;
        }
      ).id;
      db.prepare("INSERT INTO recordings (node_id) VALUES (?)").run(recording);
      const fileId = (
        db
          .prepare(
            `INSERT INTO files (recording_node_id, library_root_id, file_path, file_mtime, file_size, tags_raw, disc_no, track_no)
             VALUES (?, ?, ?, datetime('now'), 0, ?, ?, ?) RETURNING id`,
          )
          .get(
            recording,
            root,
            filePath,
            JSON.stringify(tags),
            (tags.discNo as number | undefined) ?? null,
            (tags.trackNo as number | undefined) ?? null,
          ) as {
          id: number;
        }
      ).id;
      db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'appears_on', 'local')").run(
        recording,
        albumId,
      );
      return { fileId, recording };
    };
    write({ db, album, file });
    expect(db.prepare("SELECT COUNT(*) AS n FROM release_identity_upgrade").get()).toEqual({ n: 0 });
    db.close();
    return openDb(dbPath, { log: () => {} });
  }

  const AMCHITKA = "Amchitka-The 1970 Concert That Launched Greenpeace";
  const amchitkaPath = (sub: string, n: number, performer: string) =>
    `/m/Various Artists/${AMCHITKA} CD1/${sub}/${String(n).padStart(2, "0")} - ${performer}.flac`;
  const amchitkaTags = (sub: string, n: number, performer: string, disc: number) => ({
    album: `${AMCHITKA} ${sub}`,
    albumartist: performer,
    artist: performer,
    discNo: disc,
    trackNo: n,
  });

  it("merges a compilation 0045 split by performer into one album, keeping the favourite and the oldest node", () => {
    let joni = 0;
    let phil = 0;
    let james = 0;
    const files: Filed[] = [];
    const db = filedLibrary(({ db, album, file }) => {
      const t = AMCHITKA.toLowerCase();
      const folder = `/m/Various Artists/${AMCHITKA} CD1`;
      joni = album(AMCHITKA, [JSON.stringify(["artist", t, "joni mitchell"]), JSON.stringify(["folder", t, folder])]);
      phil = album(AMCHITKA, [JSON.stringify(["artist", t, "phil ochs"])]);
      james = album(AMCHITKA, [JSON.stringify(["artist", t, "james taylor"])]);
      files.push(file(amchitkaPath("CD1", 1, "Phil Ochs"), phil, amchitkaTags("CD1", 1, "Phil Ochs", 1)));
      files.push(file(amchitkaPath("CD1", 12, "James Taylor"), james, amchitkaTags("CD1", 12, "James Taylor", 1)));
      files.push(file(amchitkaPath("CD2", 1, "Joni Mitchell"), joni, amchitkaTags("CD2", 1, "Joni Mitchell", 2)));
      db.prepare("INSERT INTO favourites (node_id) VALUES (?)").run(james);
    });

    const result = upgradeReleaseIdentities(db)!;
    expect(result).toMatchObject({ albums: 1, merged: 2, split: 0 });
    for (const f of files) expect(albumOf(db, f.recording)).toBe(joni);
    expect(releaseCount(db)).toBe(1);
    expect(db.prepare("SELECT node_id FROM favourites").all()).toEqual([{ node_id: joni }]);
    expect(db.prepare("SELECT disc_no FROM files ORDER BY id").all()).toEqual([
      { disc_no: 1 },
      { disc_no: 1 },
      { disc_no: 2 },
    ]);
    // The performers' keys are gone: another Phil Ochs album of that title
    // elsewhere wouldn't land here.
    expect(db.prepare("SELECT key FROM release_keys").all()).toEqual([
      { key: JSON.stringify(["folder", AMCHITKA.toLowerCase(), `/m/Various Artists/${AMCHITKA} CD1`]) },
    ]);
    // And a re-derive changes nothing.
    for (const f of files) deriveLocalEdges(db, f.fileId);
    for (const f of files) expect(albumOf(db, f.recording)).toBe(joni);
    expect(releaseCount(db)).toBe(1);
  });

  it("merges one artist's album tagged with ALBUMARTIST in one folder and only ARTIST in another", () => {
    let own = 0;
    let reissue = 0;
    const files: Filed[] = [];
    const db = filedLibrary(({ album, file }) => {
      const t = "i ain't marching anymore";
      own = album("I Ain't Marching Anymore", [JSON.stringify(["artist", t, "phil ochs"])]);
      reissue = album("I Ain't Marching Anymore", [
        JSON.stringify(["folder", t, "/m/Phil Ochs/All News That's Fit to Sing"]),
      ]);
      files.push(
        file("/m/Phil Ochs/I Ain't Marching Anymore/01.flac", own, {
          album: "I Ain't Marching Anymore",
          albumartist: "Phil Ochs",
          artist: "Phil Ochs",
          trackNo: 1,
        }),
      );
      files.push(
        file("/m/Phil Ochs/All News That's Fit to Sing/CD2/01.flac", reissue, {
          album: "I Ain't Marching Anymore",
          artist: "Phil Ochs",
          discNo: 2,
          trackNo: 1,
        }),
      );
    });
    expect(upgradeReleaseIdentities(db)).toMatchObject({ albums: 1, merged: 1, split: 0 });
    expect(albumOf(db, files[0]!.recording)).toBe(own);
    expect(albumOf(db, files[1]!.recording)).toBe(own);
    expect(title(db, reissue)).toBeUndefined();
  });

  it("doesn't read a recording with files on two albums as a split", () => {
    let revolver = 0;
    let yellowSubmarine = 0;
    let shared: Filed = { fileId: 0, recording: 0 };
    const db = filedLibrary(({ db, album, file }) => {
      revolver = album("Revolver", [JSON.stringify(["artist", "revolver", "beatles"])]);
      yellowSubmarine = album("Yellow Submarine", [JSON.stringify(["artist", "yellow submarine", "beatles"])]);
      const beatles = (folder: string, title: string, n: number, node: number) =>
        file(`/m/The Beatles/${folder}/${n}.flac`, node, {
          album: title,
          albumartist: "The Beatles",
          artist: "The Beatles",
          trackNo: n,
        });
      beatles("Revolver", "Revolver", 1, revolver);
      beatles("Yellow Submarine", "Yellow Submarine", 2, yellowSubmarine);
      // One recording, one copy on each album: its one appears_on edge is
      // the copy derived last's.
      shared = beatles("Yellow Submarine", "Yellow Submarine", 1, yellowSubmarine);
      const copy = db
        .prepare(
          `INSERT INTO files (recording_node_id, library_root_id, file_path, file_mtime, file_size, tags_raw, track_no)
           SELECT recording_node_id, library_root_id, '/m/The Beatles/Revolver/6.flac', file_mtime, 0, ?, 6
             FROM files WHERE id = ? RETURNING id`,
        )
        .get(
          JSON.stringify({ album: "Revolver", albumartist: "The Beatles", artist: "The Beatles", trackNo: 6 }),
          shared.fileId,
        ) as { id: number };
      expect(copy.id).toBeGreaterThan(shared.fileId);
    });
    const result = upgradeReleaseIdentities(db)!;
    expect(result).toMatchObject({ albums: 2, merged: 0, split: 0, needCovers: [] });
    expect(albumOf(db, shared.recording)).toBe(yellowSubmarine);
    expect(title(db, revolver)).toBe("Revolver");
  });

  it("leaves two artists' Greatest Hits apart, in one folder with colliding numbers and in two folders", () => {
    const files: Filed[] = [];
    const db = filedLibrary(({ album, file }) => {
      const t = "greatest hits";
      const queen = album("Greatest Hits", [JSON.stringify(["artist", t, "queen"])]);
      const abba = album("Greatest Hits", [JSON.stringify(["artist", t, "abba"])]);
      const hits = (folder: string, name: string, n: number, node: number) =>
        files.push(
          file(`/m/${folder}/${name} ${n}.flac`, node, {
            album: "Greatest Hits",
            albumartist: name,
            artist: name,
            trackNo: n,
          }),
        );
      hits("Hits", "Queen", 1, queen);
      hits("Hits", "ABBA", 1, abba);
      hits("Hits", "Queen", 2, queen);
      hits("ABBA/Greatest Hits", "ABBA", 2, abba);
    });
    expect(upgradeReleaseIdentities(db)).toMatchObject({ albums: 2, merged: 0, split: 0 });
    expect(albumOf(db, files[2]!.recording)).toBe(albumOf(db, files[0]!.recording));
    expect(albumOf(db, files[1]!.recording)).not.toBe(albumOf(db, files[0]!.recording));
    expect(albumOf(db, files[3]!.recording)).toBe(albumOf(db, files[1]!.recording));
    expect(releaseCount(db)).toBe(2);
  });
});

describe("attachUpgradedCovers", () => {
  it("reads an album's art from its own files and puts it on the album", async () => {
    const folder = path.join(dataDir, "music", "ABBA", "Greatest Hits");
    mkdirSync(folder, { recursive: true });
    const audio = path.join(folder, "01.wav");
    writeSilentWav(audio);
    writeFileSync(path.join(folder, "cover.jpg"), "not really a jpeg");

    let abba = { fileId: 0, recording: 0, album: 0 };
    let queen = { fileId: 0, recording: 0, album: 0 };
    const db = oldLibrary(({ db, file }) => {
      queen = file("/m/Queen/Greatest Hits/01.flac", { albumartist: "Queen", album: "Greatest Hits" });
      file("/m/Queen/Greatest Hits/02.flac", { albumartist: "Queen", album: "Greatest Hits" });
      abba = file(audio, { albumartist: "ABBA", album: "Greatest Hits" });
      // The shared node's art was ABBA's file's.
      db.prepare(
        "INSERT INTO cover_art (node_id, source, hash, origin_file_id) VALUES (?, 'embedded', 'abba-art', ?)",
      ).run(queen.album, abba.fileId);
    });
    const result = upgradeReleaseIdentities(db)!;
    const abbaAlbum = albumOf(db, abba.recording);
    // ABBA's album took the art with it; Queen's has none of its own now.
    expect(result.needCovers).toEqual([queen.album]);

    // Queen's files aren't on this machine, so its album is counted as one
    // that couldn't be read, and gets a Cover Art Archive lookup instead.
    const covers = await attachUpgradedCovers(db, result.needCovers);
    expect(covers).toMatchObject({ read: 0, queued: 1, failed: 1 });
    expect(covers.firstError).toContain("/m/Queen/Greatest Hits/01.flac");
    expect(db.prepare("SELECT node_id, job_type FROM enrich_jobs WHERE job_type = 'cover_art_lookup'").all()).toEqual([
      { node_id: queen.album, job_type: "cover_art_lookup" },
    ]);

    // And an album without art that can be read gets it from its folder.
    db.prepare("DELETE FROM cover_art WHERE node_id = ?").run(abbaAlbum);
    expect(await attachUpgradedCovers(db, [abbaAlbum])).toMatchObject({ read: 1, queued: 0, failed: 0 });
    expect(db.prepare("SELECT source, hash FROM cover_art WHERE node_id = ?").all(abbaAlbum)).toEqual([
      { source: "folder", hash: "folder-art-hash" },
    ]);
  });

  it("queues no Cover Art Archive lookup when enrichment is turned off", async () => {
    let queen = { fileId: 0, recording: 0, album: 0 };
    const db = oldLibrary(({ db, file }) => {
      db.prepare("INSERT INTO settings (key, value) VALUES ('enrichmentEnabled', 'false')").run();
      queen = file("/m/Queen/Greatest Hits/01.flac", { albumartist: "Queen", album: "Greatest Hits" });
      file("/m/ABBA/Greatest Hits/01.flac", { albumartist: "ABBA", album: "Greatest Hits" });
    });
    const result = upgradeReleaseIdentities(db)!;
    expect(result.needCovers).toContain(queen.album);
    expect(await attachUpgradedCovers(db, result.needCovers)).toMatchObject({ queued: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM enrich_jobs").get()).toEqual({ n: 0 });
  });
});

// A minimal-but-valid WAV (silence), as scanner.spec.ts writes one.
function writeSilentWav(filePath: string, seconds = 1, sampleRate = 8000): void {
  const dataSize = seconds * sampleRate * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  writeFileSync(filePath, buffer);
}
