import type { Database } from "../sqlite.js";
import type { FastifyInstance } from "fastify";
import { countLibraryArtists } from "./library.js";

type CountsRow = {
  artists: number;
  albums: number;
  tracks: number;
  totalBytes: number;
  totalDurationMs: number;
};

type TopRow = { id: number; title: string; playCount: number };

// Top artist/album by play count is derived through the same 'performed_by'/
// 'appears_on' edges the entity aggregates use (entities/aggregate.ts) rather
// than through the artists/albums tables directly — those tables hold
// current-library aggregates, not play counts, and joining plays straight
// through the edge that actually links a recording to its artist/release
// avoids a second source of truth for that relationship.
//
// CROSS JOIN pins plays as the outer loop, each play then finding its
// recording's few edges by edges_from_node_idx. Left to choose, SQLite walked
// every edge and looked each one up in plays: about 2.4 s per call at 30,000
// albums (3.2M edges) even with nothing played, which held up every /stats,
// and the Library header reads its counts from /stats (#302).
//
// Keeping planner statistics current (issue #354) doesn't make this
// unnecessary. Once plays has rows and statistics, SQLite picks this order
// itself. But ANALYZE records nothing for an empty table, and with nothing
// played SQLite takes plays for a large table and walks every edge: 0.53 s
// at 30,000 albums with every other table's statistics current.
function topByEdge(db: Database, edgeType: "performed_by" | "appears_on"): TopRow | null {
  return (
    (db
      .prepare(
        `SELECT n.id AS id, n.title AS title, COUNT(*) AS playCount
         FROM plays p
         CROSS JOIN edges e ON e.from_node = p.recording_node_id AND e.type = ?
         JOIN nodes n ON n.id = e.to_node
         GROUP BY e.to_node
         ORDER BY playCount DESC, n.id ASC
         LIMIT 1`,
      )
      .get(edgeType) as TopRow | undefined) ?? null
  );
}

function topTrack(db: Database): TopRow | null {
  return (
    (db
      .prepare(
        `SELECT n.id AS id, n.title AS title, COUNT(*) AS playCount
         FROM plays p
         JOIN nodes n ON n.id = p.recording_node_id
         GROUP BY p.recording_node_id
         ORDER BY playCount DESC, n.id ASC
         LIMIT 1`,
      )
      .get() as TopRow | undefined) ?? null
  );
}

export function statsRoutes(db: Database) {
  return async function routes(app: FastifyInstance) {
    app.get("/stats", async () => {
      const counts = db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM albums) AS albums,
             -- Tracks, not files: one recording can have a file on two
             -- records (the same "Yellow Submarine" on Revolver and on
             -- its own soundtrack), and the library and the map count it
             -- once. Bytes and duration below stay per file: that's what's
             -- on disk.
             (SELECT COUNT(DISTINCT recording_node_id) FROM files WHERE missing_since IS NULL) AS tracks,
             (SELECT COALESCE(SUM(file_size), 0) FROM files WHERE missing_since IS NULL) AS totalBytes,
             (SELECT COALESCE(SUM(duration_ms), 0) FROM files WHERE missing_since IS NULL) AS totalDurationMs`,
        )
        .get() as Omit<CountsRow, "artists">;

      return {
        // The artists the library lists, not every artists row: that table
        // also holds featured-only artists, which the Artists tab leaves out.
        // The Library header reads its counts from here (#302), so they
        // have to be the tab's.
        artists: countLibraryArtists(db),
        ...counts,
        topArtist: topByEdge(db, "performed_by"),
        topAlbum: topByEdge(db, "appears_on"),
        topTrack: topTrack(db),
      };
    });
  };
}
