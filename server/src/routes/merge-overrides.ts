import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { collapseFile } from "../match/collapse.js";
import { deriveLocalEdges } from "../match/edges.js";
import { broadcast } from "../ws.js";

export function mergeOverridesRoutes(db: Database.Database) {
  return async function routes(app: FastifyInstance) {
    // Tier-3 (fuzzy) candidates awaiting confirmation — never auto-applied.
    app.get("/merge-suggestions", async () =>
      db
        .prepare(
          `SELECT f.id AS file_id, f.file_path, f.recording_node_id, f.fuzzy_candidate_node_id,
                  n.title AS current_title, c.title AS candidate_title
           FROM files f
           JOIN nodes n ON n.id = f.recording_node_id
           JOIN nodes c ON c.id = f.fuzzy_candidate_node_id
           WHERE f.match_source = 'fuzzy_pending'
           ORDER BY f.id`,
        )
        .all(),
    );

    // Records a decision and applies it immediately. forcedRecordingNodeId
    // null means "force split" — the file gets its own standalone node.
    // Either way this is the user layer winning permanently: collapseFile()
    // checks merge_overrides before every tier on every future re-scan, so
    // this decision is never silently re-evaluated.
    app.post<{ Body: { fileId: number; forcedRecordingNodeId: number | null; reason?: string } }>(
      "/merge-overrides",
      async (request, reply) => {
        const { fileId, forcedRecordingNodeId, reason } = request.body;
        const file = db.prepare("SELECT id FROM files WHERE id = ?").get(fileId);
        if (!file) {
          reply.code(404);
          return { error: "file not found" };
        }

        const override = db
          .prepare(
            `INSERT INTO merge_overrides (file_id, forced_recording_node_id, decided_by, reason)
             VALUES (?, ?, 'user', ?) RETURNING *`,
          )
          .get(fileId, forcedRecordingNodeId, reason ?? null);

        await collapseFile(db, fileId);
        deriveLocalEdges(db, fileId);
        broadcast("hygiene:changed", { fileId });

        return override;
      },
    );
  };
}
