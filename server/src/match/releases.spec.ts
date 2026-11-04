import { beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "../sqlite.js";
import { openDb } from "../db.js";
import { deriveLocalEdges } from "./edges.js";
import { albumIdentities, type AlbumFile } from "./albumIdentity.js";
import { ALBUM_FOLDER_SQL, albumFolderParams, findOrCreateRelease, findRelease } from "./releases.js";

// Issue #465: which album node a file's appears_on edge lands on.

let db: Database;
let root: number;

beforeEach(() => {
  db = openDb(":memory:");
  root = (db.prepare("INSERT INTO library_roots (path) VALUES ('/m') RETURNING id").get() as { id: number }).id;
});

function addFile(filePath: string, tags: Record<string, unknown>): number {
  const node = db.prepare("INSERT INTO nodes (type, title) VALUES ('recording', ?) RETURNING id").get(filePath) as {
    id: number;
  };
  db.prepare("INSERT INTO recordings (node_id) VALUES (?)").run(node.id);
  return (
    db
      .prepare(
        `INSERT INTO files (recording_node_id, library_root_id, file_path, file_mtime, file_size, tags_raw)
         VALUES (?, ?, ?, datetime('now'), 0, ?) RETURNING id`,
      )
      .get(node.id, root, filePath, JSON.stringify(tags)) as { id: number }
  ).id;
}

/** Derives each file in the order given, and returns the title of the album
 *  each one landed on, by node: files on one node share an entry. */
function albumsOf(fileIds: number[]): { title: string; files: number[] }[] {
  for (const id of fileIds) deriveLocalEdges(db, id);
  const rows = db
    .prepare(
      `SELECT f.id AS fileId, n.id AS nodeId, n.title FROM files f
         JOIN edges e ON e.from_node = f.recording_node_id AND e.type = 'appears_on'
         JOIN nodes n ON n.id = e.to_node
        ORDER BY n.id, f.id`,
    )
    .all() as { fileId: number; nodeId: number; title: string }[];
  const byNode = new Map<number, { title: string; files: number[] }>();
  for (const row of rows) {
    const album = byNode.get(row.nodeId) ?? { title: row.title, files: [] };
    album.files.push(row.fileId);
    byNode.set(row.nodeId, album);
  }
  return [...byNode.values()];
}

describe("disc suffixes", () => {
  it("files Amchitka's two discs, in one folder, as one album without the suffix", () => {
    const one = addFile("/m/Various/Amchitka/101.flac", {
      artist: "James Taylor",
      album: "Amchitka-The 1970 Concert That Launched Greenpeace CD1",
    });
    const two = addFile("/m/Various/Amchitka/201.flac", {
      artist: "Joni Mitchell",
      album: "Amchitka-The 1970 Concert That Launched Greenpeace CD2",
    });
    expect(albumsOf([one, two])).toEqual([
      { title: "Amchitka-The 1970 Concert That Launched Greenpeace", files: [one, two] },
    ]);
  });

  it("files Farewells & Fantasies' three discs as one album", () => {
    const files = [1, 2, 3].map((disc) =>
      addFile(`/m/Phil Ochs/Farewells & Fantasies/${disc}01.flac`, {
        artist: "Phil Ochs",
        albumartist: "Phil Ochs",
        album: `Farewells & Fantasies (disc ${disc})`,
      }),
    );
    expect(albumsOf(files)).toEqual([{ title: "Farewells & Fantasies", files }]);
  });

  it("files The Best Of The Doors' discs in CD1/ and CD2/ as one album", () => {
    const one = addFile("/m/The Doors/The Best Of The Doors/CD1/01.flac", {
      artist: "The Doors",
      album: "The Best Of The Doors [CD1]",
    });
    const two = addFile("/m/The Doors/The Best Of The Doors/CD2/01.flac", {
      artist: "The Doors",
      album: "The Best Of The Doors [CD2]",
    });
    expect(albumsOf([one, two])).toEqual([{ title: "The Best Of The Doors", files: [one, two] }]);
  });

  it("leaves a set marker and a catalogue number in the title", () => {
    const wilburys = addFile("/m/Traveling Wilburys/Collection/01.flac", {
      album: "The Traveling Wilburys Collection [2CD]",
    });
    const pretender = addFile("/m/Jackson Browne/The Pretender/01.flac", { album: "The Pretender [DCC GZS-1047]" });
    expect(albumsOf([wilburys, pretender]).map((a) => a.title)).toEqual([
      "The Traveling Wilburys Collection [2CD]",
      "The Pretender [DCC GZS-1047]",
    ]);
  });

  it("files a set's discs in disc subfolders as one album when the titles carry no suffix", () => {
    const one = addFile("/m/Bob Dylan/Blonde on Blonde/Disc 1/01.flac", {
      artist: "Bob Dylan",
      album: "Blonde on Blonde",
    });
    const two = addFile("/m/Bob Dylan/Blonde on Blonde/Disc 2/01.flac", {
      artist: "Bob Dylan",
      album: "Blonde on Blonde",
    });
    expect(albumsOf([one, two])).toEqual([{ title: "Blonde on Blonde", files: [one, two] }]);
  });
});

describe("an album's artist", () => {
  it("keeps two artists' Greatest Hits apart in one folder when their track numbers collide", () => {
    const hits = (name: string, n: number, albumartist: string | null) =>
      addFile(`/m/Hits/${name} ${n}.flac`, { artist: name, albumartist, album: "Greatest Hits", trackNo: n });
    const queen = hits("Queen", 1, "Queen");
    const abba = hits("ABBA", 1, "ABBA");
    const queenAgain = hits("Queen", 2, "Queen");
    expect(albumsOf([queen, abba, queenAgain])).toEqual([
      { title: "Greatest Hits", files: [queen, queenAgain] },
      { title: "Greatest Hits", files: [abba] },
    ]);
  });

  it("keeps them apart without ALBUMARTIST too", () => {
    const hits = (name: string, n: number) =>
      addFile(`/m/Hits/${name} ${n}.flac`, { artist: name, album: "Greatest Hits", trackNo: n });
    const files = [hits("Queen", 1), hits("ABBA", 1), hits("Queen", 2), hits("ABBA", 2)];
    expect(albumsOf(files).map((a) => a.files)).toEqual([
      [files[0], files[2]],
      [files[1], files[3]],
    ]);
  });

  // The reference library's Amchitka: a live compilation whose ALBUMARTIST
  // is each track's performer, on two discs in CD1/ and CD2/.
  const amchitka = (sub: string, n: number, performer: string, disc: number) =>
    addFile(
      `/m/Various Artists/Amchitka-The 1970 Concert That Launched Greenpeace CD1/${sub}/${String(n).padStart(2, "0")} - ${performer}.flac`,
      {
        album: `Amchitka-The 1970 Concert That Launched Greenpeace ${sub}`,
        albumartist: performer,
        artist: performer,
        discNo: disc,
        trackNo: n,
      },
    );

  it("keeps a compilation tagged with each performer as ALBUMARTIST as one album", () => {
    const files = [
      amchitka("CD1", 1, "Phil Ochs", 1),
      amchitka("CD1", 12, "James Taylor", 1),
      amchitka("CD2", 1, "Joni Mitchell", 2),
    ];
    expect(albumsOf(files)).toEqual([{ title: "Amchitka-The 1970 Concert That Launched Greenpeace", files }]);
  });

  it("ends with one album for a compilation whose files arrive one at a time, once they're all derived again", () => {
    const one = amchitka("CD1", 1, "Phil Ochs", 1);
    deriveLocalEdges(db, one);
    const two = amchitka("CD1", 12, "James Taylor", 1);
    deriveLocalEdges(db, two);
    const three = amchitka("CD2", 1, "Joni Mitchell", 2);
    expect(albumsOf([three, two, one])).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE type = 'release'").get()).toEqual({ n: 1 });
  });

  it("puts one artist's album tagged with ALBUMARTIST in one folder and only ARTIST in another together", () => {
    const own = addFile("/m/Phil Ochs/I Ain't Marching Anymore/01.flac", {
      album: "I Ain't Marching Anymore",
      albumartist: "Phil Ochs",
      artist: "Phil Ochs",
      trackNo: 1,
    });
    // A two-albums-on-one-CD reissue, its second disc tagged as the album.
    const reissue = addFile("/m/Phil Ochs/All News That's Fit to Sing/CD2/01.flac", {
      album: "I Ain't Marching Anymore",
      artist: "Phil Ochs",
      discNo: 2,
      trackNo: 1,
    });
    const other = addFile("/m/Phil Ochs/All News That's Fit to Sing/CD1/01.flac", {
      album: "All News That's Fit to Sing",
      artist: "Phil Ochs",
      discNo: 1,
      trackNo: 1,
    });
    expect(albumsOf([reissue, own, other])).toEqual([
      { title: "I Ain't Marching Anymore", files: [own, reissue] },
      { title: "All News That's Fit to Sing", files: [other] },
    ]);
  });

  it("keeps two artists' Greatest Hits apart by folder when neither has ALBUMARTIST", () => {
    const queen = addFile("/m/Queen/Greatest Hits/01.flac", { artist: "Queen", album: "Greatest Hits" });
    const abba = addFile("/m/ABBA/Greatest Hits/01.flac", { artist: "ABBA", album: "Greatest Hits" });
    expect(albumsOf([queen, abba])).toHaveLength(2);
  });

  it("keeps one artist's album together across folders by ALBUMARTIST", () => {
    const one = addFile("/m/Queen/Greatest Hits I/01.flac", {
      artist: "Queen",
      albumartist: "Queen",
      album: "Greatest Hits",
    });
    const two = addFile("/m/Downloads/greatest hits/02.flac", {
      artist: "Queen",
      albumartist: "queen ",
      album: "greatest hits",
    });
    expect(albumsOf([one, two])).toEqual([{ title: "Greatest Hits", files: [one, two] }]);
  });

  it("keeps a compilation without ALBUMARTIST in one folder as one album", () => {
    const files = ["The Byrds", "The Turtles", "Buffalo Springfield"].map((artist, i) =>
      addFile(`/m/Compilations/Nuggets/0${i}.flac`, { artist, album: "Nuggets" }),
    );
    expect(albumsOf(files)).toEqual([{ title: "Nuggets", files }]);
  });

  it("keeps an album where only some tracks have ALBUMARTIST as one album, whichever is derived first", () => {
    const tagged = addFile("/m/Wings/Band on the Run/01.flac", {
      artist: "Wings",
      albumartist: "Wings",
      album: "Band on the Run",
    });
    const untagged = addFile("/m/Wings/Band on the Run/02.flac", {
      artist: "Paul McCartney & Wings",
      album: "Band on the Run",
    });
    expect(albumsOf([tagged, untagged])).toEqual([{ title: "Band on the Run", files: [tagged, untagged] }]);

    db = openDb(":memory:");
    root = (db.prepare("INSERT INTO library_roots (path) VALUES ('/m') RETURNING id").get() as { id: number }).id;
    const tagged2 = addFile("/m/Wings/Band on the Run/01.flac", {
      artist: "Wings",
      albumartist: "Wings",
      album: "Band on the Run",
    });
    const untagged2 = addFile("/m/Wings/Band on the Run/02.flac", {
      artist: "Paul McCartney & Wings",
      album: "Band on the Run",
    });
    expect(albumsOf([untagged2, tagged2])).toEqual([{ title: "Band on the Run", files: [tagged2, untagged2] }]);
  });

  it("keeps its node when an album without ALBUMARTIST gets one", () => {
    const file = addFile("/m/Wings/Band on the Run/01.flac", { album: "Band on the Run" });
    const [before] = albumsOf([file]);
    db.prepare("UPDATE files SET tags_raw = ? WHERE id = ?").run(
      JSON.stringify({ album: "Band on the Run", albumartist: "Wings" }),
      file,
    );
    deriveLocalEdges(db, file);
    const nodes = db.prepare("SELECT id, title FROM nodes WHERE type = 'release'").all();
    expect(nodes).toHaveLength(1);
    expect(albumsOf([file])).toEqual([before!]);
  });

  it("lands on the same node however often or in whatever order the files are derived", () => {
    const files = [
      addFile("/m/Queen/GH/CD1/01.flac", { albumartist: "Queen", album: "Greatest Hits CD1" }),
      addFile("/m/ABBA/GH/01.flac", { albumartist: "ABBA", album: "Greatest Hits" }),
      addFile("/m/Queen/GH/CD2/01.flac", { albumartist: "Queen", album: "Greatest Hits CD2" }),
      addFile("/m/Comp/GH/01.flac", { artist: "X", album: "Greatest Hits" }),
    ];
    const first = albumsOf(files);
    expect(first.map((a) => a.files)).toEqual([[files[0]!, files[2]!], [files[1]!], [files[3]!]]);
    expect(albumsOf([...files].reverse())).toEqual(first);
    expect(db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE type = 'release'").get()).toEqual({ n: 3 });
  });
});

describe("findRelease", () => {
  const harvest = (filePath: string, tags: Partial<AlbumFile> = {}) =>
    albumIdentities([
      {
        id: 1,
        path: filePath,
        album: "Harvest",
        albumartist: null,
        artist: null,
        discNo: null,
        trackNo: null,
        ...tags,
      },
    ]).get(1)!;

  it("only reads: it finds what findOrCreateRelease made and makes nothing", () => {
    const identity = harvest("/m/Neil Young/Harvest/01.flac", { albumartist: "Neil Young" });
    expect(findRelease(db, identity)).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM release_keys").get()).toEqual({ n: 0 });
    const nodeId = findOrCreateRelease(db, identity);
    expect(findRelease(db, identity)).toBe(nodeId);
    // The folder key is the way in for an album with no artist at all.
    expect(findRelease(db, harvest("/m/Neil Young/Harvest/02.flac"))).toBe(nodeId);
    // But not for another artist's album of that title in that folder.
    expect(findRelease(db, harvest("/m/Neil Young/Harvest/03.flac", { albumartist: "X" }))).toBeNull();
  });
});

describe("reading an album folder", () => {
  it("is ranges of files.file_path's index, not a scan", () => {
    const plan = (
      db.prepare(`EXPLAIN QUERY PLAN ${ALBUM_FOLDER_SQL}`).all(...albumFolderParams("/m/a")) as { detail: string }[]
    ).map((row) => row.detail);
    expect(plan.join("\n")).not.toMatch(/SCAN files/);
    expect(
      plan.filter((detail) => /USING INDEX sqlite_autoindex_files_1 \(file_path>\? AND file_path<\?\)/.test(detail)),
    ).toHaveLength(6);
  });

  it("doesn't read a folder whose name only starts with the album folder's", () => {
    const five = addFile("/srv/music/5/01.flac", { album: "Five", artist: "A", trackNo: 1 });
    addFile("/srv/music/50/01.flac", { album: "Five", artist: "B", trackNo: 1 });
    addFile("/srv/music/5000/01.flac", { album: "Five", artist: "C", trackNo: 1 });
    const rows = db.prepare(ALBUM_FOLDER_SQL).all(...albumFolderParams("/srv/music/5")) as { id: number }[];
    expect(rows.map((row) => row.id)).toEqual([five]);
  });

  it("finds a disc folder's files and a sibling folder named after a disc, and nothing deeper or beside", () => {
    const files = [
      addFile("/m/Various/Amchitka/01.flac", { album: "Amchitka", artist: "A", trackNo: 1 }),
      addFile("/m/Various/Amchitka/CD2/01.flac", { album: "Amchitka", artist: "B", trackNo: 1, discNo: 2 }),
      addFile("/m/Various/Amchitka CD3/01.flac", { album: "Amchitka", artist: "C", trackNo: 1 }),
    ];
    // Same title, but another album folder: a live album beside it, and a
    // folder inside the disc folder.
    const beside = addFile("/m/Various/Amchitka Live/01.flac", { album: "Amchitka", artist: "D", trackNo: 1 });
    const deeper = addFile("/m/Various/Amchitka/CD2/Bonus/01.flac", { album: "Amchitka", artist: "E", trackNo: 1 });
    const albums = albumsOf([...files, beside, deeper]);
    expect(albums.find((a) => a.files.includes(files[0]!))!.files).toEqual(files);
    expect(albums).toHaveLength(3);
  });
});
