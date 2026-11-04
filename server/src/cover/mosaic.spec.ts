import { beforeEach, describe, expect, it } from "bun:test";
import Fastify from "fastify";
import type { Database } from "../sqlite.js";
import { openDb } from "../db.js";
import { favouritesMosaic, mosaicAlbums, pickMosaic, playlistMosaic } from "./mosaic.js";
import {
  addTracksToPlaylist,
  createPlaylist,
  deletePlaylist,
  listPlaylists,
  listPlaylistTracks,
  removeTrackFromPlaylist,
  reorderPlaylistTrack,
} from "../routes/playlists.js";
import { addFavourite, favouritesRoutes, removeFavourite } from "../routes/favourites.js";

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe("pickMosaic (#462)", () => {
  const albums = range(101, 112);

  it("picks up to four distinct albums, the same on every call and in any order", () => {
    const cells = pickMosaic("playlist:1", [...albums, ...albums], []);
    expect(cells).toHaveLength(4);
    expect(new Set(cells).size).toBe(4);
    expect(cells.every((id) => id != null && albums.includes(id))).toBe(true);
    expect(pickMosaic("playlist:1", [...albums].reverse(), [])).toEqual(cells);
    expect(cells).toEqual(mosaicAlbums("playlist:1", albums));
  });

  it("is random-looking: not the first four, and not the same four for every playlist", () => {
    const picks = range(1, 6).map((id) => mosaicAlbums(`playlist:${id}`, albums).join(","));
    expect(new Set(picks).size).toBeGreaterThan(1);
    expect(picks.some((pick) => pick !== "101,102,103,104")).toBe(true);
  });

  it("leaves the cells it has no album for empty", () => {
    expect(pickMosaic("playlist:1", [7, 8], [])).toEqual(expect.arrayContaining([7, 8, null, null]));
    expect(pickMosaic("playlist:1", [7, 8], []).slice(2)).toEqual([null, null]);
    expect(pickMosaic("playlist:1", [], [])).toEqual([null, null, null, null]);
  });

  it("changes only the removed album's cell when an album leaves, every one of the four in turn", () => {
    const before = pickMosaic("playlist:1", albums, []);
    // The album ranked fifth, first of those not shown.
    const fifth = mosaicAlbums("playlist:1", albums.filter((id) => !before.includes(id)))[0];
    for (const leaving of before) {
      const after = pickMosaic("playlist:1", albums.filter((id) => id !== leaving), before);
      const changed = range(0, 3).filter((i) => after[i] !== before[i]);
      expect(changed).toEqual([before.indexOf(leaving)]);
      expect(after[before.indexOf(leaving)]).toBe(fifth);
    }
  });

  it("whatever order two albums leave in, each removal moves one cell", () => {
    let cells = pickMosaic("playlist:1", albums, []);
    let left = [...albums];
    for (const leaving of [cells[2], cells[0], cells[3]]) {
      left = left.filter((id) => id !== leaving);
      const next = pickMosaic("playlist:1", left, cells);
      expect(range(0, 3).filter((i) => next[i] !== cells[i])).toEqual([cells.indexOf(leaving)]);
      cells = next;
    }
  });

  it("changes nothing when an album outside the four leaves", () => {
    const before = pickMosaic("playlist:1", albums, []);
    const outside = albums.find((id) => !before.includes(id))!;
    expect(pickMosaic("playlist:1", albums.filter((id) => id !== outside), before)).toEqual(before);
  });

  it("lets a new album in only by the ranking, into the displaced album's cell", () => {
    const before = pickMosaic("playlist:1", albums, []);
    const candidates = range(200, 260);
    // One that ranks into the four, and one that doesn't.
    const strong = candidates.find((id) => mosaicAlbums("playlist:1", [...albums, id]).includes(id))!;
    const weak = candidates.find((id) => !mosaicAlbums("playlist:1", [...albums, id]).includes(id))!;
    expect(pickMosaic("playlist:1", [...albums, weak], before)).toEqual(before);
    const after = pickMosaic("playlist:1", [...albums, strong], before);
    const changed = range(0, 3).filter((i) => after[i] !== before[i]);
    expect(changed).toHaveLength(1);
    expect(after[changed[0]]).toBe(strong);
  });

  it("refills a cell whose album appears twice, keeping the first", () => {
    const cells = pickMosaic("playlist:1", [1, 2, 3, 4, 5], [1, 1, 2, 3]);
    expect(cells[0]).toBe(1);
    expect(new Set(cells).size).toBe(4);
  });
});

let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
});

function node(type: string, title: string): number {
  return (db.prepare("INSERT INTO nodes (type, title) VALUES (?, ?) RETURNING id").get(type, title) as { id: number }).id;
}

function album(): number {
  return node("release", "Album");
}

function track(onAlbum: number | null): number {
  const id = node("recording", "Track");
  if (onAlbum != null) {
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'appears_on', 'local')").run(id, onAlbum);
  }
  return id;
}

const writes = () => (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
const coverOf = (playlistId: number) => listPlaylists(db).find((p) => p.id === playlistId)!.cover_ids;
const rowOf = (playlistId: number, nodeId: number) => listPlaylistTracks(db, playlistId).find((t) => t.id === nodeId)!.playlist_track_id;

describe("a playlist's cover", () => {
  it("shows distinct albums, not one album four times", () => {
    const first = album();
    const others = range(1, 3).map(() => album());
    const playlist = createPlaylist(db, "Opens with one record").id;
    addTracksToPlaylist(db, playlist, [track(first), track(first), track(first), track(first), ...others.map((a) => track(a))]);
    expect([...coverOf(playlist)].sort()).toEqual([first, ...others].sort());
  });

  it("keeps empty cells for fewer than four albums, and a track on no record stands for itself", () => {
    const record = album();
    const loose = track(null);
    const playlist = createPlaylist(db, "Two").id;
    addTracksToPlaylist(db, playlist, [track(record), loose, track(record)]);
    const cover = coverOf(playlist);
    expect([...cover.slice(0, 2)].sort()).toEqual([record, loose].sort());
    expect(cover.slice(2)).toEqual([null, null]);
    expect(coverOf(createPlaylist(db, "Empty").id)).toEqual([null, null, null, null]);
  });

  it("reads the same cover every time without writing anything", () => {
    const playlist = createPlaylist(db, "Steady").id;
    addTracksToPlaylist(db, playlist, range(1, 8).map(() => track(album())));
    const cover = coverOf(playlist);
    const before = writes();
    expect(coverOf(playlist)).toEqual(cover);
    expect(playlistMosaic(db, playlist)).toEqual(cover);
    expect(writes()).toBe(before);
  });

  it("changes only when an album's last track goes, and then only that album's cell", () => {
    const albums = range(1, 8).map(() => album());
    const tracks = albums.flatMap((a) => [track(a), track(a)]);
    const playlist = createPlaylist(db, "Two from each").id;
    addTracksToPlaylist(db, playlist, tracks);
    const before = coverOf(playlist);
    const shown = before[1]!;
    const [one, two] = tracks.filter((_, i) => albums[Math.floor(i / 2)] === shown);

    removeTrackFromPlaylist(db, playlist, rowOf(playlist, one));
    expect(coverOf(playlist)).toEqual(before);

    removeTrackFromPlaylist(db, playlist, rowOf(playlist, two));
    const after = coverOf(playlist);
    expect(range(0, 3).filter((i) => after[i] !== before[i])).toEqual([1]);
    expect(after).not.toContain(shown);
  });

  it("changes nothing when tracks are reordered", () => {
    const playlist = createPlaylist(db, "Shuffled by hand").id;
    const tracks = range(1, 6).map(() => track(album()));
    addTracksToPlaylist(db, playlist, tracks);
    const before = coverOf(playlist);
    reorderPlaylistTrack(db, playlist, rowOf(playlist, tracks[5]), 1);
    reorderPlaylistTrack(db, playlist, rowOf(playlist, tracks[0]), 6);
    expect(coverOf(playlist)).toEqual(before);
  });

  it("shows the same four albums whichever order the tracks were added in", () => {
    const tracks = range(1, 9).map(() => track(album()));
    const a = createPlaylist(db, "Forwards").id;
    addTracksToPlaylist(db, a, tracks);
    // The pick depends on the playlist's id, so compare against the ranking.
    expect(coverOf(a)).toEqual(mosaicAlbums(`playlist:${a}`, listPlaylistTracks(db, a).map((t) => t.id).map(albumOf)));
    const b = createPlaylist(db, "One at a time").id;
    for (const t of [...tracks].reverse()) addTracksToPlaylist(db, b, [t]);
    expect([...coverOf(b)].sort()).toEqual([...mosaicAlbums(`playlist:${b}`, tracks.map(albumOf))].sort());
  });

  it("refills only the cell whose album the library took away, and saves it once", () => {
    const albums = range(1, 6).map(() => album());
    const tracks = albums.map((a) => track(a));
    const playlist = createPlaylist(db, "Scanned under").id;
    addTracksToPlaylist(db, playlist, tracks);
    const before = coverOf(playlist);
    const gone = before[2]!;
    // A scan deletes the track (its node, and so its playlist row).
    db.prepare("DELETE FROM edges WHERE to_node = ?").run(gone);
    db.prepare("DELETE FROM nodes WHERE id = ?").run(tracks[albums.indexOf(gone)]);
    const after = coverOf(playlist);
    expect(range(0, 3).filter((i) => after[i] !== before[i])).toEqual([2]);
    const saved = writes();
    expect(coverOf(playlist)).toEqual(after);
    expect(writes()).toBe(saved);
  });

  it("gives a playlist from before the cells existed its cover on first read", () => {
    const playlist = createPlaylist(db, "Old").id;
    const tracks = range(1, 5).map(() => track(album()));
    addTracksToPlaylist(db, playlist, tracks);
    db.prepare("DELETE FROM playlist_mosaic_cells").run();
    expect(coverOf(playlist).filter((id) => id != null)).toHaveLength(4);
    expect((db.prepare("SELECT COUNT(*) AS n FROM playlist_mosaic_cells").get() as { n: number }).n).toBe(4);
  });

  it("leaves nothing behind when the playlist is deleted", () => {
    const playlist = createPlaylist(db, "Gone").id;
    addTracksToPlaylist(db, playlist, [track(album())]);
    deletePlaylist(db, playlist);
    expect((db.prepare("SELECT COUNT(*) AS n FROM playlist_mosaic_cells").get() as { n: number }).n).toBe(0);
  });
});

function albumOf(trackId: number): number {
  const row = db.prepare("SELECT to_node FROM edges WHERE from_node = ? AND type = 'appears_on'").get(trackId) as {
    to_node: number;
  } | null;
  return row?.to_node ?? trackId;
}

describe("the favourites' cover", () => {
  it("counts a favourite track and its record once, and an artist as itself", async () => {
    const record = album();
    const artist = node("artist", "Artist");
    addFavourite(db, track(record));
    addFavourite(db, record);
    addFavourite(db, artist);
    expect([...favouritesMosaic(db).slice(0, 2)].sort()).toEqual([record, artist].sort());

    const app = Fastify();
    await app.register(favouritesRoutes(db), { prefix: "/api/v1" });
    const res = await app.inject({ method: "GET", url: "/api/v1/favourites/cover" });
    expect(res.json()).toEqual({ cover_ids: favouritesMosaic(db) });
  });

  it("changes only the cell of a favourite that's taken away", () => {
    const tracks = range(1, 7).map(() => track(album()));
    for (const t of tracks) addFavourite(db, t);
    const before = favouritesMosaic(db);
    const leaving = tracks.find((t) => albumOf(t) === before[3])!;
    removeFavourite(db, leaving);
    const after = favouritesMosaic(db);
    expect(range(0, 3).filter((i) => after[i] !== before[i])).toEqual([3]);
  });
});
