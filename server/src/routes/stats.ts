import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";

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
function topByEdge(db: Database.Database, edgeType: "performed_by" | "appears_on"): TopRow | null {
  return (
    (db
      .prepare(
        `SELECT n.id AS id, n.title AS title, COUNT(*) AS playCount
         FROM plays p
         JOIN edges e ON e.from_node = p.recording_node_id AND e.type = ?
         JOIN nodes n ON n.id = e.to_node
         GROUP BY e.to_node
         ORDER BY playCount DESC, n.id ASC
         LIMIT 1`,
      )
      .get(edgeType) as TopRow | undefined) ?? null
  );
}

function topTrack(db: Database.Database): TopRow | null {
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

export function statsRoutes(db: Database.Database) {
  return async function routes(app: FastifyInstance) {
    app.get("/stats", async () => {
      const counts = db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM artists) AS artists,
             (SELECT COUNT(*) FROM albums) AS albums,
             (SELECT COUNT(*) FROM files WHERE missing_since IS NULL) AS tracks,
             (SELECT COALESCE(SUM(file_size), 0) FROM files WHERE missing_since IS NULL) AS totalBytes,
             (SELECT COALESCE(SUM(duration_ms), 0) FROM files WHERE missing_since IS NULL) AS totalDurationMs`,
        )
        .get() as CountsRow;

      return {
        ...counts,
        topArtist: topByEdge(db, "performed_by"),
        topAlbum: topByEdge(db, "appears_on"),
        topTrack: topTrack(db),
      };
    });
  };
}
