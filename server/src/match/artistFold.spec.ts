import { beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "../sqlite.js";
import { openDb } from "../db.js";
import { foldArtistNameVariants, foldArtistNameVariantsIfDue } from "./artistFold.js";
import { artistNameKey } from "./artistLookup.js";
import { recompute } from "../recompute.js";
import { refreshBridgeMembers } from "../entities/bridges.js";

let db: Database;
let logged: { level: string; message: string }[];
const log = (level: "info" | "error", message: string) => logged.push({ level, message });

beforeEach(() => {
  db = openDb(":memory:");
  logged = [];
});

const WILBURYS = "4387b544-e4d0-4f18-b74e-d4a5ba1582ab";

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

// Made the way the old exact-name lookups made them, past today's rule.
function makeArtist(title: string, mbid?: string): number {
  const id = (db.prepare("INSERT INTO nodes (type, title) VALUES ('artist', ?) RETURNING id").get(title) as { id: number })
    .id;
  if (mbid) {
    db.prepare(
      "INSERT INTO field_provenance (node_id, field, value, source, confidence) VALUES (?, 'artist_mbid', ?, 'musicbrainz', 1)",
    ).run(id, mbid);
  }
  return id;
}

function artistByTitle(title: string): number {
  return (db.prepare("SELECT id FROM nodes WHERE type = 'artist' AND title = ?").get(title) as { id: number }).id;
}

function memberOf(member: number, group: number): void {
  db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'member_of', 'musicbrainz')").run(
    member,
    group,
  );
}

function exists(nodeId: number): boolean {
  return db.prepare("SELECT 1 FROM nodes WHERE id = ?").get(nodeId) !== undefined;
}

function artistKeysShared(): string[] {
  const titles = (db.prepare("SELECT title FROM nodes WHERE type = 'artist'").all() as { title: string }[]).map(
    (r) => r.title,
  );
  const seen = new Set<string>();
  const shared: string[] = [];
  for (const title of titles) {
    const key = artistNameKey(title);
    if (seen.has(key)) shared.push(key);
    seen.add(key);
  }
  return shared;
}

// The reference library as the coordinator found it on the Pi: node 802
// from the tags, with the files and the position, and node 1007 from
// MusicBrainz, with the id and every member's edge.
function wilburysTwice() {
  insertFile({ artist: "The Beatles", album: "Abbey Road", releaseDate: "1969" });
  insertFile({ artist: "The Traveling Wilburys", album: "Vol. 1", releaseDate: "1988" });
  insertFile({ artist: "Bob Dylan", album: "Blonde on Blonde", releaseDate: "1966" });
  insertFile({ artist: "Tom Petty", album: "Full Moon Fever", releaseDate: "1989" });
  recompute(db);
  const beatles = artistByTitle("The Beatles");
  const tagged = artistByTitle("The Traveling Wilburys");
  const dylan = artistByTitle("Bob Dylan");
  const petty = artistByTitle("Tom Petty");
  const fromMusicBrainz = makeArtist("Traveling Wilburys", WILBURYS);
  const harrison = makeArtist("George Harrison");
  const orbison = makeArtist("Roy Orbison");
  memberOf(dylan, fromMusicBrainz);
  memberOf(petty, fromMusicBrainz);
  memberOf(harrison, fromMusicBrainz);
  memberOf(orbison, fromMusicBrainz);
  memberOf(harrison, beatles);
  return { beatles, tagged, fromMusicBrainz, dylan, petty, harrison, orbison };
}

describe("folding artists whose names differ only by 'The', at startup", () => {
  it("folds MusicBrainz's 'Traveling Wilburys' into the tags' 'The Traveling Wilburys', edges and all", () => {
    const { tagged, fromMusicBrainz, dylan, petty, harrison, orbison } = wilburysTwice();

    const fold = foldArtistNameVariantsIfDue(db, log);

    expect(fold).toEqual({ merged: 1, recomputeAfter: false });
    expect(exists(fromMusicBrainz)).toBe(false);
    expect(db.prepare("SELECT title FROM nodes WHERE id = ?").get(tagged)).toEqual({ title: "The Traveling Wilburys" });
    const members = (
      db.prepare("SELECT from_node AS id FROM edges WHERE type = 'member_of' AND to_node = ? ORDER BY from_node").all(
        tagged,
      ) as { id: number }[]
    ).map((r) => r.id);
    expect(members).toEqual([dylan, petty, harrison, orbison].sort((a, b) => a - b));
    // The id comes across, so the next relation naming the band finds it.
    expect(
      db.prepare("SELECT value FROM field_provenance WHERE node_id = ? AND field = 'artist_mbid'").get(tagged),
    ).toEqual({ value: WILBURYS });
    expect(logged).toEqual([
      {
        level: "info",
        message: 'artists: folded 1 artist node(s) into another whose name differs only by case, spaces or "The"',
      },
    ]);
  });

  it("keeps the survivor's favourite, photo, position and manual connections", () => {
    const { tagged, fromMusicBrainz, beatles } = wilburysTwice();
    db.prepare("INSERT INTO favourites (node_id) VALUES (?)").run(tagged);
    db.prepare("INSERT INTO cover_art (node_id, source, hash) VALUES (?, 'artist_image', 'tagged-photo')").run(tagged);
    db.prepare("INSERT INTO cover_art (node_id, source, hash) VALUES (?, 'artist_image', 'other-photo')").run(
      fromMusicBrainz,
    );
    db.prepare("UPDATE positions SET user_x = 12, user_y = 34 WHERE node_id = ?").run(tagged);
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'personal', 'manual')").run(
      tagged,
      beatles,
    );

    foldArtistNameVariantsIfDue(db, log);

    expect(db.prepare("SELECT 1 AS yes FROM favourites WHERE node_id = ?").get(tagged)).toEqual({ yes: 1 });
    expect(db.prepare("SELECT hash FROM cover_art WHERE node_id = ? AND source = 'artist_image'").all(tagged)).toEqual([
      { hash: "tagged-photo" },
    ]);
    expect(db.prepare("SELECT user_x, user_y FROM positions WHERE node_id = ?").get(tagged)).toEqual({
      user_x: 12,
      user_y: 34,
    });
    expect(
      db.prepare("SELECT to_node FROM edges WHERE from_node = ? AND type = 'personal' AND source = 'manual'").get(tagged),
    ).toEqual({ to_node: beatles });
  });

  it("takes the other node's favourite and photo when the survivor has none", () => {
    const { tagged, fromMusicBrainz } = wilburysTwice();
    db.prepare("INSERT INTO favourites (node_id) VALUES (?)").run(fromMusicBrainz);
    db.prepare("INSERT INTO cover_art (node_id, source, hash) VALUES (?, 'artist_image', 'other-photo')").run(
      fromMusicBrainz,
    );

    foldArtistNameVariantsIfDue(db, log);

    expect(db.prepare("SELECT 1 AS yes FROM favourites WHERE node_id = ?").get(tagged)).toEqual({ yes: 1 });
    expect(db.prepare("SELECT hash FROM cover_art WHERE node_id = ?").all(tagged)).toEqual([{ hash: "other-photo" }]);
  });

  it("then lets the start place George Harrison between The Beatles and the Wilburys, and no second Wilburys", () => {
    // index.ts folds before it places bridge members. The other way round,
    // the duplicate, a band with no files linking Dylan and Petty, would be
    // placed as a second Wilburys.
    const { beatles, tagged, harrison } = wilburysTwice();

    foldArtistNameVariantsIfDue(db, log);

    expect(refreshBridgeMembers(db)).toEqual({ added: [harrison], removed: [] });
    const seed = (id: number) =>
      db.prepare("SELECT seed_x AS x, seed_y AS y FROM positions WHERE node_id = ?").get(id) as { x: number; y: number };
    expect(seed(harrison)).toEqual({ x: (seed(beatles).x + seed(tagged).x) / 2, y: (seed(beatles).y + seed(tagged).y) / 2 });
  });

  it("runs once: a start after it reads one row and folds nothing", () => {
    wilburysTwice();
    foldArtistNameVariantsIfDue(db, log);
    expect(db.prepare("SELECT folded_at IS NOT NULL AS done FROM artist_name_fold").get()).toEqual({ done: 1 });

    const later = makeArtist("the beatles");
    expect(foldArtistNameVariantsIfDue(db, log)).toBeNull();
    expect(exists(later)).toBe(true);
    expect(logged).toHaveLength(1);
  });

  it("logs a start with nothing to fold, and still records that it ran", () => {
    makeArtist("The Beatles");

    expect(foldArtistNameVariantsIfDue(db, log)).toEqual({ merged: 0, recomputeAfter: false });
    expect(logged).toEqual([{ level: "info", message: 'artists: no artist names differ only by case, spaces or "The"' }]);
    expect(db.prepare("SELECT folded_at IS NOT NULL AS done FROM artist_name_fold").get()).toEqual({ done: 1 });
  });

  it("leaves no artist whose name differs from another's only by case, spaces or 'The'", () => {
    makeArtist("The Band");
    makeArtist("Band");
    makeArtist("  the band ");
    makeArtist("BAND");
    makeArtist("The Beatles");
    makeArtist("Beatles");
    makeArtist("Theatre of Tragedy");

    expect(foldArtistNameVariants(db).merged).toBe(4);

    expect(artistKeysShared()).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE type = 'artist'").get()).toEqual({ n: 3 });
  });

  it("keeps the node with files, then the one on the map, then the oldest", () => {
    const placed = makeArtist("Beatles");
    const withFiles = makeArtist("The Beatles");
    const oldest = makeArtist("Wilburys");
    makeArtist("The Wilburys");
    db.prepare("INSERT INTO positions (node_id, granularity, seed_x, seed_y) VALUES (?, 'tracks', 0, 0)").run(placed);
    const track = insertFile({});
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'performed_by', 'local')").run(
      track,
      withFiles,
    );
    const lonely = makeArtist("Doors");
    const onMap = makeArtist("The Doors");
    db.prepare("INSERT INTO positions (node_id, granularity, seed_x, seed_y) VALUES (?, 'tracks', 0, 0)").run(onMap);

    foldArtistNameVariants(db);

    expect([placed, withFiles, oldest, lonely, onMap].map(exists)).toEqual([false, true, true, false, true]);
  });

  it("keeps two artists apart when their MusicBrainz ids differ, and folds a node with no id into the survivor", () => {
    const doors = makeArtist("The Doors", "mbid-the-doors");
    const sameDoors = makeArtist("the doors ", "mbid-the-doors");
    const tribute = makeArtist("Doors", "mbid-tribute-act");
    const unknown = makeArtist("DOORS");
    const track = insertFile({});
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'performed_by', 'local')").run(
      track,
      tribute,
    );

    expect(foldArtistNameVariants(db).merged).toBe(2);

    expect([doors, sameDoors, tribute, unknown].map(exists)).toEqual([true, false, true, false]);
    // The node with no id joins the one the whole set would keep: the one
    // with files.
    expect(db.prepare("SELECT COUNT(*) AS n FROM edges WHERE to_node = ?").get(tribute)).toEqual({ n: 1 });
  });

  it("asks for a recompute once the server listens when a node it folded away had tracks", () => {
    const old = makeArtist("Traveling Wilburys");
    const tagged = makeArtist("The Traveling Wilburys");
    for (const artist of [old, tagged]) {
      const track = insertFile({});
      db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'performed_by', 'local')").run(
        track,
        artist,
      );
    }

    expect(foldArtistNameVariantsIfDue(db, log)).toEqual({ merged: 1, recomputeAfter: true });
    expect(db.prepare("SELECT COUNT(*) AS n FROM edges WHERE type = 'performed_by' AND to_node = ?").get(old)).toEqual({
      n: 2,
    });
  });

  it("leaves everything as it was, records nothing and logs it when the fold fails, so the next start tries again", () => {
    const { fromMusicBrainz } = wilburysTwice();
    db.exec("CREATE TEMP TRIGGER refuse BEFORE DELETE ON nodes BEGIN SELECT RAISE(ABORT, 'disk on fire'); END");

    expect(foldArtistNameVariantsIfDue(db, log)).toBeNull();

    expect(exists(fromMusicBrainz)).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM edges WHERE to_node = ?").get(fromMusicBrainz)).toEqual({ n: 4 });
    expect(db.prepare("SELECT folded_at FROM artist_name_fold").get()).toEqual({ folded_at: null });
    expect(logged[0]!.level).toBe("error");
    expect(logged[0]!.message).toContain("disk on fire");

    db.exec("DROP TRIGGER temp.refuse");
    expect(foldArtistNameVariantsIfDue(db, log)).toEqual({ merged: 1, recomputeAfter: false });
  });
});
