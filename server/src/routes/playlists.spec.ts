import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "../db.js";
import {
  addTrackToPlaylist,
  createPlaylist,
  deletePlaylist,
  listPlaylists,
  listPlaylistTracks,
  removeTrackFromPlaylist,
  renamePlaylist,
  reorderPlaylistTrack,
} from "./playlists.js";

let db: Database.Database;

beforeEach(() => {
  db = openDb(":memory:");
});

function makeNode(type: string, title: string): number {
  const row = db.prepare("INSERT INTO nodes (type, title) VALUES (?, ?) RETURNING id").get(type, title) as {
    id: number;
  };
  return row.id;
}

describe("playlists", () => {
  it("creates, renames, and deletes a playlist", () => {
    const playlist = createPlaylist(db, "Late Night Drive");
    expect(playlist.name).toBe("Late Night Drive");
    expect(listPlaylists(db)).toHaveLength(1);

    const renamed = renamePlaylist(db, playlist.id, "Late Night Drive v2");
    expect(renamed.name).toBe("Late Night Drive v2");
    expect(listPlaylists(db)[0].name).toBe("Late Night Drive v2");

    deletePlaylist(db, playlist.id);
    expect(listPlaylists(db)).toEqual([]);
  });

  it("adds tracks to a playlist in append order", () => {
    const playlist = createPlaylist(db, "Set List");
    const a = makeNode("recording", "A");
    const b = makeNode("recording", "B");
    const c = makeNode("recording", "C");

    addTrackToPlaylist(db, playlist.id, a);
    addTrackToPlaylist(db, playlist.id, b);
    addTrackToPlaylist(db, playlist.id, c);

    const tracks = listPlaylistTracks(db, playlist.id);
    expect(tracks.map((t) => t.id)).toEqual([a, b, c]);
    expect(tracks.map((t) => t.position)).toEqual([1, 2, 3]);
  });

  it("reorders a track from the middle to the front, keeping positions dense", () => {
    const playlist = createPlaylist(db, "Set List");
    const a = makeNode("recording", "A");
    const b = makeNode("recording", "B");
    const c = makeNode("recording", "C");
    addTrackToPlaylist(db, playlist.id, a);
    const trackB = addTrackToPlaylist(db, playlist.id, b);
    addTrackToPlaylist(db, playlist.id, c);

    reorderPlaylistTrack(db, playlist.id, trackB.id, 1);

    const tracks = listPlaylistTracks(db, playlist.id);
    expect(tracks.map((t) => t.id)).toEqual([b, a, c]);
    expect(tracks.map((t) => t.position)).toEqual([1, 2, 3]);
  });

  it("reorders a track from the front to the end, keeping positions dense", () => {
    const playlist = createPlaylist(db, "Set List");
    const a = makeNode("recording", "A");
    const b = makeNode("recording", "B");
    const c = makeNode("recording", "C");
    const trackA = addTrackToPlaylist(db, playlist.id, a);
    addTrackToPlaylist(db, playlist.id, b);
    addTrackToPlaylist(db, playlist.id, c);

    reorderPlaylistTrack(db, playlist.id, trackA.id, 3);

    const tracks = listPlaylistTracks(db, playlist.id);
    expect(tracks.map((t) => t.id)).toEqual([b, c, a]);
    expect(tracks.map((t) => t.position)).toEqual([1, 2, 3]);
  });

  it("removes a track from the middle and renumbers remaining tracks with no gap", () => {
    const playlist = createPlaylist(db, "Set List");
    const a = makeNode("recording", "A");
    const b = makeNode("recording", "B");
    const c = makeNode("recording", "C");
    addTrackToPlaylist(db, playlist.id, a);
    const trackB = addTrackToPlaylist(db, playlist.id, b);
    addTrackToPlaylist(db, playlist.id, c);

    removeTrackFromPlaylist(db, playlist.id, trackB.id);

    const tracks = listPlaylistTracks(db, playlist.id);
    expect(tracks.map((t) => t.id)).toEqual([a, c]);
    expect(tracks.map((t) => t.position)).toEqual([1, 2]);
  });

  it("allows the same node in the same playlist twice, and in more than one playlist", () => {
    const playlist1 = createPlaylist(db, "Set 1");
    const playlist2 = createPlaylist(db, "Set 2");
    const trackNode = makeNode("recording", "Repeat Track");

    addTrackToPlaylist(db, playlist1.id, trackNode);
    addTrackToPlaylist(db, playlist1.id, trackNode);
    addTrackToPlaylist(db, playlist2.id, trackNode);

    expect(listPlaylistTracks(db, playlist1.id)).toHaveLength(2);
    expect(listPlaylistTracks(db, playlist2.id)).toHaveLength(1);
  });

  it("reports an accurate track_count in listPlaylists", () => {
    const playlist = createPlaylist(db, "Set List");
    const a = makeNode("recording", "A");
    const b = makeNode("recording", "B");

    expect(listPlaylists(db).find((p) => p.id === playlist.id)?.track_count).toBe(0);

    addTrackToPlaylist(db, playlist.id, a);
    addTrackToPlaylist(db, playlist.id, b);

    expect(listPlaylists(db).find((p) => p.id === playlist.id)?.track_count).toBe(2);
  });
});
