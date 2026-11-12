import type { Database } from "../sqlite.js";
import type { FastifyInstance } from "fastify";
import { findMostDissimilar, findMostSimilar, preloadSimilarityVectors } from "../similarity/similarity.js";
import { indexBytes } from "../similarity/vectorIndex.js";
import { resolveCoverForNode } from "../cover/extract.js";

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
// Now resolved through the same shared chain both the image endpoint and the
// graph's node list use, rather than a third local rendition of it.
//
// Issue #382: the ranking reads vectors the server keeps in memory until a
// recompute changes them, so a node deleted since (a hygiene merge, say) can
// still be ranked. It's left out.
function hydrate(db: Database, ranked: RankedResult[]) {
  const nodeRow = db.prepare(`SELECT title, type FROM nodes WHERE id = ?`);
  return ranked.flatMap((r) => {
    const node = nodeRow.get(r.nodeId) as { title: string; type: string } | undefined;
    if (!node) return [];
    return {
      id: r.nodeId,
      title: node.title,
      type: node.type,
      has_cover: resolveCoverForNode(db, r.nodeId) != null,
      score: r.score,
    };
  });
}

export function similarityRoutes(db: Database) {
  return async function routes(app: FastifyInstance) {
    // Issue #494: the vectors both routes rank against are read as soon as
    // the server listens, in the background and a slice at a time, rather
    // than by the first request, which on a Raspberry Pi at 30,000 albums
    // waited 1.9 s for them. That keeps them in memory on every server,
    // whether or not anything asks: about 800 bytes an album, 24 MB of arrays
    // at 30,000. Not awaited, so listening doesn't wait for it. app.inject
    // (the specs) never listens, so it never runs there.
    app.addHook("onListen", () => {
      const started = performance.now();
      preloadSimilarityVectors(db).then(
        (index) => {
          if (index.ids.length === 0) return;
          app.log.info(
            `similarity: ${index.ids.length} vectors in memory (${(indexBytes(index) / 1e6).toFixed(1)} MB), read in ${Math.round(performance.now() - started)} ms`,
          );
        },
        (err) =>
          app.log.warn(`similarity: reading the vectors failed, and the first ranking tries again: ${err instanceof Error ? err.message : String(err)}`),
      );
    });

    app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
      "/nodes/:id/similar",
      async (request, reply) => {
        const nodeId = Number(request.params.id);
        if (!Number.isInteger(nodeId)) {
          reply.code(400);
          return { error: "invalid node id" };
        }
        const limit = Math.min(Number(request.query.limit ?? 3), 20);
        return hydrate(db, await findMostSimilar(db, nodeId, limit));
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
        return hydrate(db, await findMostDissimilar(db, nodeId, limit));
      },
    );
  };
}
