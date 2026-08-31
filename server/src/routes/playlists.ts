import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { broadcast } from "../ws.js";

// The ordered, multi-membership counterpart to favourites (see 0022's
// migration comment for why that's a separate table rather than an
// extension of favourites). position is a plain ascending integer, kept
// dense (1..N, no gaps) per playlist by every function here that touches
// it — nothing enforces that at the schema level, so it's a contract the
// route functions own instead.

export type PlaylistRow = { id: number; name: string; created_at: string; updated_at: string };
export type PlaylistListRow = PlaylistRow & { track_count: number };
export type PlaylistTrackRow = {
  id: number;
  playlist_id: number;
  node_id: number;
  position: number;
  added_at: string;
};
export type PlaylistTrackDetail = {
  id: number;
  title: string;
  track_no: number | null;
  disc_no: number | null;
  canonical_duration_ms: number | null;
  position: number;
  playlist_track_id: number;
};

export function listPlaylists(db: Database.Database): PlaylistListRow[] {
  return db
    .prepare(
      `SELECT p.id, p.name, p.created_at, p.updated_at,
              (SELECT COUNT(*) FROM playlist_tracks pt WHERE pt.playlist_id = p.id) AS track_count
       FROM playlists p
       ORDER BY p.updated_at DESC`,
    )
    .all() as PlaylistListRow[];
}

export function createPlaylist(db: Database.Database, name: string): PlaylistRow {
  return db
    .prepare("INSERT INTO playlists (name) VALUES (?) RETURNING id, name, created_at, updated_at")
    .get(name) as PlaylistRow;
}

export function renamePlaylist(db: Database.Database, id: number, name: string): PlaylistRow {
  return db
    .prepare(
      `UPDATE playlists SET name = ?, updated_at = datetime('now')
       WHERE id = ? RETURNING id, name, created_at, updated_at`,
    )
    .get(name, id) as PlaylistRow;
}

export function deletePlaylist(db: Database.Database, id: number): void {
  db.prepare("DELETE FROM playlists WHERE id = ?").run(id);
}

// Same join-and-collapse shape as GET /nodes/:id/tracklist (nodes.ts),
// through playlist_tracks instead of edges. GROUP BY pt.id rather than
// n.id — a node can legitimately appear in this result more than once
// (same track twice in one playlist), so collapsing on the node would
// wrongly merge those rows back into one.
export function listPlaylistTracks(db: Database.Database, playlistId: number): PlaylistTrackDetail[] {
  return db
    .prepare(
      `SELECT n.id, n.title, f.track_no, f.disc_no, r.canonical_duration_ms,
              pt.position, pt.id AS playlist_track_id
       FROM playlist_tracks pt
       JOIN nodes n ON n.id = pt.node_id
       LEFT JOIN recordings r ON r.node_id = n.id
       LEFT JOIN files f ON f.recording_node_id = n.id
       WHERE pt.playlist_id = ?
       GROUP BY pt.id
       ORDER BY pt.position, pt.id`,
    )
    .all(playlistId) as PlaylistTrackDetail[];
}

export function addTrackToPlaylist(db: Database.Database, playlistId: number, nodeId: number): PlaylistTrackRow {
  return db.transaction(() => {
    const { maxPosition } = db
      .prepare("SELECT MAX(position) AS maxPosition FROM playlist_tracks WHERE playlist_id = ?")
      .get(playlistId) as { maxPosition: number | null };

    const row = db
      .prepare(
        `INSERT INTO playlist_tracks (playlist_id, node_id, position) VALUES (?, ?, ?)
         RETURNING id, playlist_id, node_id, position, added_at`,
      )
      .get(playlistId, nodeId, (maxPosition ?? 0) + 1) as PlaylistTrackRow;

    db.prepare("UPDATE playlists SET updated_at = datetime('now') WHERE id = ?").run(playlistId);

    return row;
  })();
}

// Renumbers the whole playlist rather than just shifting the range between
// old and new position — simpler to reason about, and the row counts here
// (a playlist's track list) never get large enough for that to matter.
export function reorderPlaylistTrack(
  db: Database.Database,
  playlistId: number,
  trackRowId: number,
  newPosition: number,
): void {
  db.transaction(() => {
    const rows = db
      .prepare("SELECT id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position, id")
      .all(playlistId) as { id: number }[];

    const ids = rows.map((row) => row.id);
    const currentIndex = ids.indexOf(trackRowId);
    if (currentIndex === -1) return;

    ids.splice(currentIndex, 1);
    const targetIndex = Math.min(Math.max(newPosition, 1), ids.length + 1) - 1;
    ids.splice(targetIndex, 0, trackRowId);

    const updatePosition = db.prepare("UPDATE playlist_tracks SET position = ? WHERE id = ?");
    ids.forEach((id, index) => updatePosition.run(index + 1, id));

    db.prepare("UPDATE playlists SET updated_at = datetime('now') WHERE id = ?").run(playlistId);
  })();
}

export function removeTrackFromPlaylist(db: Database.Database, playlistId: number, trackRowId: number): void {
  db.transaction(() => {
    db.prepare("DELETE FROM playlist_tracks WHERE id = ? AND playlist_id = ?").run(trackRowId, playlistId);

    const rows = db
      .prepare("SELECT id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position, id")
      .all(playlistId) as { id: number }[];

    const updatePosition = db.prepare("UPDATE playlist_tracks SET position = ? WHERE id = ?");
    rows.forEach((row, index) => updatePosition.run(index + 1, row.id));

    db.prepare("UPDATE playlists SET updated_at = datetime('now') WHERE id = ?").run(playlistId);
  })();
}

export function playlistsRoutes(db: Database.Database) {
  return async function routes(app: FastifyInstance) {
    app.get("/playlists", async () => listPlaylists(db));

    app.post<{ Body: { name: string } }>("/playlists", async (request, reply) => {
      const name = request.body?.name?.trim();
      if (!name) {
        reply.code(400);
        return { error: "name must not be empty" };
      }
      const playlist = createPlaylist(db, name);
      broadcast("playlist:changed", { id: playlist.id });
      return playlist;
    });

    app.patch<{ Params: { id: string }; Body: { name: string } }>("/playlists/:id", async (request, reply) => {
      const id = Number(request.params.id);
      const name = request.body?.name?.trim();
      if (!name) {
        reply.code(400);
        return { error: "name must not be empty" };
      }
      const playlist = renamePlaylist(db, id, name);
      broadcast("playlist:changed", { id });
      return playlist;
    });

    app.delete<{ Params: { id: string } }>("/playlists/:id", async (request) => {
      const id = Number(request.params.id);
      deletePlaylist(db, id);
      broadcast("playlist:changed", { id });
      return { ok: true };
    });

    app.get<{ Params: { id: string } }>("/playlists/:id/tracks", async (request) => {
      return listPlaylistTracks(db, Number(request.params.id));
    });

    app.post<{ Params: { id: string }; Body: { nodeId: number } }>(
      "/playlists/:id/tracks",
      async (request) => {
        const playlistId = Number(request.params.id);
        const track = addTrackToPlaylist(db, playlistId, request.body.nodeId);
        broadcast("playlist:tracks-changed", { playlistId });
        return track;
      },
    );

    app.patch<{ Params: { id: string; trackRowId: string }; Body: { position: number } }>(
      "/playlists/:id/tracks/:trackRowId",
      async (request) => {
        const playlistId = Number(request.params.id);
        const trackRowId = Number(request.params.trackRowId);
        reorderPlaylistTrack(db, playlistId, trackRowId, request.body.position);
        broadcast("playlist:tracks-changed", { playlistId });
        return { ok: true };
      },
    );

    app.delete<{ Params: { id: string; trackRowId: string } }>(
      "/playlists/:id/tracks/:trackRowId",
      async (request) => {
        const playlistId = Number(request.params.id);
        const trackRowId = Number(request.params.trackRowId);
        removeTrackFromPlaylist(db, playlistId, trackRowId);
        broadcast("playlist:tracks-changed", { playlistId });
        return { ok: true };
      },
    );
  };
}
