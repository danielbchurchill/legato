import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { Database } from "../sqlite.js";
import { openDb } from "../db.js";
import { subscribe } from "../ws.js";
import {
  addTrackToPlaylist,
  addTracksToPlaylist,
  createPlaylist,
  deletePlaylist,
  listPlaylists,
  listPlaylistTracks,
  removeTrackFromPlaylist,
  MAX_TRACKS_PER_ADD,
  playlistsRoutes,
  renamePlaylist,
  reorderPlaylistTrack,
  tracksToAdd,
} from "./playlists.js";

let db: Database;

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

// #448: a whole album goes into a playlist in one request, in its order.
describe("adding several tracks at once", () => {
  it("appends them after what's there, in the order given, positions dense", () => {
    const playlist = createPlaylist(db, "Road trip");
    const [a, b, c, d] = ["A", "B", "C", "D"].map((t) => makeNode("recording", t));
    addTrackToPlaylist(db, playlist.id, a);

    const rows = addTracksToPlaylist(db, playlist.id, [d, b, c]);

    expect(rows.map((r) => r.node_id)).toEqual([d, b, c]);
    const tracks = listPlaylistTracks(db, playlist.id);
    expect(tracks.map((t) => t.id)).toEqual([a, d, b, c]);
    expect(tracks.map((t) => t.position)).toEqual([1, 2, 3, 4]);
  });

  it("adds a track that's already there again, as a single add does", () => {
    const playlist = createPlaylist(db, "Road trip");
    const [a, b] = ["A", "B"].map((t) => makeNode("recording", t));
    addTrackToPlaylist(db, playlist.id, a);

    addTracksToPlaylist(db, playlist.id, [a, b]);

    expect(listPlaylistTracks(db, playlist.id).map((t) => t.id)).toEqual([a, a, b]);
  });

  it("adds none of them when one of them isn't a node", () => {
    const playlist = createPlaylist(db, "Road trip");
    const a = makeNode("recording", "A");

    expect(() => addTracksToPlaylist(db, playlist.id, [a, 999_999])).toThrow();

    expect(listPlaylistTracks(db, playlist.id)).toEqual([]);
  });

  it("reads one id or a list of ids from a request body, and nothing else", () => {
    expect(tracksToAdd({ nodeId: 7 })).toEqual([7]);
    expect(tracksToAdd({ nodeIds: [3, 1, 2] })).toEqual([3, 1, 2]);
    expect(tracksToAdd({ nodeIds: [3, 1, 2], nodeId: 7 })).toEqual([3, 1, 2]);
    expect(tracksToAdd({})).toBeNull();
    expect(tracksToAdd(null)).toBeNull();
    expect(tracksToAdd({ nodeId: "7" })).toBeNull();
    expect(tracksToAdd({ nodeId: 0 })).toBeNull();
    expect(tracksToAdd({ nodeIds: [] })).toBeNull();
    expect(tracksToAdd({ nodeIds: [1, 2.5] })).toBeNull();
    expect(tracksToAdd({ nodeIds: "1,2" })).toBeNull();
    expect(tracksToAdd({ nodeIds: Array.from({ length: MAX_TRACKS_PER_ADD + 1 }, (_, i) => i + 1) })).toBeNull();
  });
});

describe("POST /playlists/:id/tracks", () => {
  let app: FastifyInstance;
  let events: { event: string; payload: unknown }[];
  let unsubscribe: () => void;

  beforeEach(async () => {
    app = Fastify();
    await app.register(playlistsRoutes(db));
    events = [];
    unsubscribe = subscribe((message) => events.push(JSON.parse(message)));
  });

  afterEach(async () => {
    unsubscribe();
    await app.close();
  });

  const post = (playlistId: number, payload: unknown) =>
    app.inject({ method: "POST", url: `/playlists/${playlistId}/tracks`, payload: payload as object });

  it("still adds one track from { nodeId }, answering with its row", async () => {
    const playlist = createPlaylist(db, "Road trip");
    const a = makeNode("recording", "A");

    const res = await post(playlist.id, { nodeId: a });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ playlist_id: playlist.id, node_id: a, position: 1 });
    expect(listPlaylistTracks(db, playlist.id).map((t) => t.id)).toEqual([a]);
    expect(events).toEqual([{ event: "playlist:tracks-changed", payload: { playlistId: playlist.id } }]);
  });

  it("adds every track from { nodeIds } in order, with one broadcast", async () => {
    const playlist = createPlaylist(db, "Road trip");
    const ids = ["One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"].map((t) => makeNode("recording", t));

    const res = await post(playlist.id, { nodeIds: ids });

    expect(res.statusCode).toBe(200);
    const rows = res.json() as { node_id: number; position: number }[];
    expect(rows.map((r) => r.node_id)).toEqual(ids);
    expect(rows.map((r) => r.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(listPlaylistTracks(db, playlist.id).map((t) => t.id)).toEqual(ids);
    expect(events).toEqual([{ event: "playlist:tracks-changed", payload: { playlistId: playlist.id } }]);
  });

  it("turns away a body with neither, and adds nothing", async () => {
    const playlist = createPlaylist(db, "Road trip");

    for (const payload of [{}, { nodeIds: [] }, { nodeIds: ["1"] }, { nodeId: null }]) {
      const res = await post(playlist.id, payload);
      expect(res.statusCode).toBe(400);
    }
    expect(listPlaylistTracks(db, playlist.id)).toEqual([]);
    expect(events).toEqual([]);
  });

  it("adds none of a list with a node that doesn't exist, and says nothing changed", async () => {
    const playlist = createPlaylist(db, "Road trip");
    const a = makeNode("recording", "A");

    const res = await post(playlist.id, { nodeIds: [a, 999_999] });

    expect(res.statusCode).not.toBe(200);
    expect(listPlaylistTracks(db, playlist.id)).toEqual([]);
    expect(events).toEqual([]);
  });
});
