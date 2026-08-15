import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { getWorklist } from "../hygiene.js";
import { applyMatch } from "../enrich/worker.js";
import { broadcast } from "../ws.js";

export function hygieneRoutes(db: Database.Database) {
  return async function routes(app: FastifyInstance) {
    app.get<{ Querystring: { type?: string } }>("/hygiene/worklist", async (request) =>
      getWorklist(db, request.query.type),
    );

    // M-5: the candidates behind an "ambiguous" enrichment_flag worklist
    // item — real rows now (server/src/migrations/0018), not a wall of
    // UUIDs in a note. Ordered by score, same ranking pickBestMatch
    // computed them in, so the top of the list is the most likely answer.
    // duration_delta_ms is computed here rather than left to the frontend
    // — the local recording's own duration isn't otherwise part of this
    // response, and every consumer of this endpoint wants the same delta.
    app.get<{ Params: { nodeId: string } }>("/hygiene/match-candidates/:nodeId", async (request) =>
      db
        .prepare(
          `SELECT mc.id, mc.mbid, mc.release_title, mc.release_date, mc.duration_ms, mc.score,
                  CASE WHEN mc.duration_ms IS NOT NULL AND r.canonical_duration_ms IS NOT NULL
                       THEN ABS(mc.duration_ms - r.canonical_duration_ms)
                       ELSE NULL END AS duration_delta_ms
           FROM match_candidates mc
           JOIN recordings r ON r.node_id = mc.node_id
           WHERE mc.node_id = ?
           ORDER BY mc.score DESC`,
        )
        .all(request.params.nodeId),
    );

    // Resolving one writes the chosen mbid through the exact same
    // applyMatch path a confident automatic match already uses — a
    // manually-resolved match is a real match, not a second-class one.
    app.post<{ Params: { nodeId: string }; Body: { mbid: string } }>(
      "/hygiene/match-candidates/:nodeId/resolve",
      async (request, reply) => {
        const nodeId = Number(request.params.nodeId);
        const candidate = db
          .prepare("SELECT mbid, score FROM match_candidates WHERE node_id = ? AND mbid = ?")
          .get(nodeId, request.body.mbid) as { mbid: string; score: number } | undefined;
        if (!candidate) {
          reply.code(404);
          return { error: "not found" };
        }

        applyMatch(db, nodeId, candidate.mbid, candidate.score);
        broadcast("hygiene:changed", { nodeId });
        reply.code(204);
      },
    );
  };
}
