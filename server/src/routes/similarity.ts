import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { findMostDissimilar, findMostSimilar } from "../similarity/similarity.js";

type RankedResult = { nodeId: number; score: number };

// Ranked results carry only node_id + score; the UI needs enough to render
// a thumbnail strip (title, whether cover art exists), resolved here in one
// query rather than making the client round-trip per result.
function hydrate(db: Database.Database, ranked: RankedResult[]) {
  const nodeRow = db.prepare(
    `SELECT n.title, n.type, EXISTS (SELECT 1 FROM cover_art ca WHERE ca.node_id = n.id) AS has_cover
     FROM nodes n WHERE n.id = ?`,
  );
  return ranked.map((r) => {
    const node = nodeRow.get(r.nodeId) as { title: string; type: string; has_cover: number };
    return { id: r.nodeId, title: node.title, type: node.type, has_cover: node.has_cover, score: r.score };
  });
}

export function similarityRoutes(db: Database.Database) {
  return async function routes(app: FastifyInstance) {
    app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
      "/nodes/:id/similar",
      async (request, reply) => {
        const nodeId = Number(request.params.id);
        if (!Number.isInteger(nodeId)) {
          reply.code(400);
          return { error: "invalid node id" };
        }
        const limit = Math.min(Number(request.query.limit ?? 3), 20);
        return hydrate(db, findMostSimilar(db, nodeId, limit));
      },
    );

    app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
      "/nodes/:id/dissimilar",
      async (request, reply) => {
        const nodeId = Number(request.params.id);
        if (!Number.isInteger(nodeId)) {
          reply.code(400);
          return { error: "invalid node id" };
        }
        const limit = Math.min(Number(request.query.limit ?? 3), 20);
        return hydrate(db, findMostDissimilar(db, nodeId, limit));
      },
    );
  };
}
