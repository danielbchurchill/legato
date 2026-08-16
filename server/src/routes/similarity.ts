import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { findMostDissimilar, findMostSimilar } from "../similarity/similarity.js";
import { coverTargetNode, resolveCover } from "../cover/extract.js";

type RankedResult = { nodeId: number; score: number };

// Ranked results carry only node_id + score; the UI needs enough to render
// a thumbnail strip (title, whether cover art exists), resolved here in one
// query rather than making the client round-trip per result.
//
// P-4: has_cover used to check cover_art directly against the result's own
// node id, which is always false for a recording — art attaches to the
// release (cover/extract.ts's coverTargetNode), not the track. The actual
// image endpoint (GET /nodes/:id/cover) already resolves this correctly, so
// this was stale-but-harmless data rather than a broken thumbnail; fixed
// here so the field means what it says for whatever does start reading it.
function hydrate(db: Database.Database, ranked: RankedResult[]) {
  const nodeRow = db.prepare(`SELECT title, type FROM nodes WHERE id = ?`);
  return ranked.map((r) => {
    const node = nodeRow.get(r.nodeId) as { title: string; type: string };
    const hasCover = resolveCover(db, r.nodeId) != null || resolveCover(db, coverTargetNode(db, r.nodeId)) != null;
    return { id: r.nodeId, title: node.title, type: node.type, has_cover: hasCover, score: r.score };
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
