import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { shouldScrobble } from "../plays/scrobble.js";

type PlayBody = { fileId: number; startedAt: string; msPlayed: number };

// The scrobble threshold is enforced here, not trusted from the client —
// usePlayback.ts reports every listening span it observes and this route is
// the single place that decides whether it actually counts as a play, so a
// future second client (LAN/remote/mobile, per Legato's platform split)
// gets the same rule for free instead of re-implementing it.
export function playsRoutes(db: Database.Database) {
  return async function routes(app: FastifyInstance) {
    app.post<{ Body: PlayBody }>("/plays", async (request, reply) => {
      const { fileId, startedAt, msPlayed } = request.body;

      const file = db.prepare("SELECT recording_node_id, duration_ms FROM files WHERE id = ?").get(fileId) as
        | { recording_node_id: number; duration_ms: number | null }
        | undefined;
      if (!file) {
        reply.code(404);
        return { error: "file not found" };
      }

      if (!shouldScrobble(msPlayed, file.duration_ms)) {
        return { recorded: false };
      }

      db.prepare(
        "INSERT INTO plays (recording_node_id, file_id, started_at, ms_played, source) VALUES (?, ?, ?, ?, 'desktop')",
      ).run(file.recording_node_id, fileId, startedAt, msPlayed);

      return { recorded: true };
    });
  };
}
