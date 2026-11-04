import { beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "../sqlite.js";
import { openDb } from "../db.js";
import {
  ARTIST_BY_MBID_QUERY,
  artistNameKey,
  artistsByKeyQuery,
  findArtistByMbid,
  findArtistByName,
  rememberArtistMbid,
} from "./artistLookup.js";

let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
});

function makeArtist(title: string, mbid?: string): number {
  const id = (db.prepare("INSERT INTO nodes (type, title) VALUES ('artist', ?) RETURNING id").get(title) as { id: number })
    .id;
  if (mbid) {
    db.prepare(
      "INSERT INTO field_provenance (node_id, field, value, source, confidence) VALUES (?, 'artist_mbid', ?, 'musicbrainz', 0.9)",
    ).run(id, mbid);
  }
  return id;
}

describe("the artist name rule", () => {
  it("ignores case, outer spaces and a leading 'The'", () => {
    const key = artistNameKey("The Traveling Wilburys");
    expect(artistNameKey("Traveling Wilburys")).toBe(key);
    expect(artistNameKey("  traveling wilburys ")).toBe(key);
    expect(artistNameKey("THE TRAVELING WILBURYS")).toBe(key);
  });

  it("drops only a whole leading word 'The', and keeps every other word", () => {
    expect(artistNameKey("Theatre of Tragedy")).toBe("theatre of tragedy");
    expect(artistNameKey("Them")).toBe("them");
    expect(artistNameKey("Dave Matthews Band")).not.toBe(artistNameKey("The Dave Matthews"));
    expect(artistNameKey("Pussy Riot")).not.toBe(artistNameKey("Pussy Riot (Karaoke)"));
  });

  it("folds case the way SQLite's lower() does, so it agrees with the title index", () => {
    // Without ICU, lower() folds only A-Z.
    expect(artistNameKey("The BJÖRK")).toBe("bjÖrk");
    const row = db.prepare("SELECT lower(trim(?)) AS lowered").get("  BJÖRK  ") as { lowered: string };
    expect(artistNameKey("  BJÖRK  ")).toBe(row.lowered);
  });

  it("finds 'The Traveling Wilburys' for 'Traveling Wilburys', and the other way round", () => {
    const tagged = makeArtist("The Traveling Wilburys");
    expect(findArtistByName(db, "Traveling Wilburys")).toBe(tagged);
    expect(findArtistByName(db, "traveling wilburys ")).toBe(tagged);

    db.prepare("DELETE FROM nodes").run();
    const fromMusicBrainz = makeArtist("Traveling Wilburys");
    expect(findArtistByName(db, "The Traveling Wilburys")).toBe(fromMusicBrainz);
  });

  it("finds nothing for a name that differs by more than the rule ignores", () => {
    makeArtist("The Traveling Wilburys");
    expect(findArtistByName(db, "Wilburys")).toBeUndefined();
    expect(findArtistByName(db, "The Traveling Wilburys Collection")).toBeUndefined();
  });

  it("keeps two artists apart when only 'The' is shared and their MusicBrainz ids differ", () => {
    makeArtist("The Doors", "mbid-doors");
    expect(findArtistByName(db, "Doors", "mbid-other-doors")).toBeUndefined();
    // With no id to compare, or the same id, they're one artist.
    expect(findArtistByName(db, "Doors")).toBeDefined();
    expect(findArtistByName(db, "Doors", "mbid-doors")).toBeDefined();
  });

  it("matches an exact name whatever the ids say, as an exact name always has", () => {
    const beatles = makeArtist("The Beatles", "mbid-a");
    expect(findArtistByName(db, "the beatles", "mbid-b")).toBe(beatles);
  });

  it("prefers the node with the same id, then one with none, over the oldest", () => {
    makeArtist("The Doors", "mbid-doors");
    const unknown = makeArtist("THE DOORS ");
    const same = makeArtist(" the doors", "mbid-tribute");
    expect(findArtistByName(db, "Doors", "mbid-tribute")).toBe(same);
    expect(findArtistByName(db, "Doors", "mbid-nobody")).toBe(unknown);
  });
});

describe("finding an artist by MusicBrainz id", () => {
  it("finds the node holding the id, whatever it's called", () => {
    const petty = makeArtist("Tom Petty & The Heartbreakers", "mbid-heartbreakers");
    expect(findArtistByMbid(db, "mbid-heartbreakers")).toBe(petty);
    expect(findArtistByMbid(db, "mbid-nobody")).toBeUndefined();
  });

  it("prefers a node with tracks of its own when two hold the id", () => {
    makeArtist("Traveling Wilburys", "mbid-wilburys");
    const tagged = makeArtist("The Traveling Wilburys", "mbid-wilburys");
    db.prepare("INSERT INTO artists (node_id, track_count, album_count) VALUES (?, 10, 1)").run(tagged);
    expect(findArtistByMbid(db, "mbid-wilburys")).toBe(tagged);
  });

  it("remembers an id only on a node that has none", () => {
    const node = makeArtist("George Harrison");
    rememberArtistMbid(db, node, "mbid-george");
    rememberArtistMbid(db, node, "mbid-someone-else");
    expect(findArtistByMbid(db, "mbid-george")).toBe(node);
    expect(findArtistByMbid(db, "mbid-someone-else")).toBeUndefined();
  });
});

function plan(sql: string, ...params: string[]): string {
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map((r) => r.detail).join("\n");
}

// Every artist a scan or a recompute derives goes through the name lookup,
// and every band-membership relation through the id lookup. A table scan
// in either goes quadratic on a large library (issue #189).
describe("the lookups' query plans", () => {
  it("looks names up through migration 0030's title index", () => {
    const { sql, params } = artistsByKeyQuery("The Traveling Wilburys");
    const detail = plan(sql, ...params);
    expect(detail).toMatch(/SEARCH nodes USING (COVERING )?INDEX nodes_type_title_lookup_idx/);
    expect(detail).not.toMatch(/^SCAN nodes$/m);
  });

  it("looks ids up through migration 0048's index", () => {
    const detail = plan(ARTIST_BY_MBID_QUERY, "mbid-wilburys");
    expect(detail).toMatch(/SEARCH fp USING INDEX field_provenance_artist_mbid_idx/);
    expect(detail).not.toMatch(/^SCAN fp$/m);
  });
});
