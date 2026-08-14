import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { coverTargetNode, recordCover, resolveCover } from "../cover/extract.js";
import { readCover, storeCover } from "../cover/store.js";
import type { CoverSize } from "../cover/store.js";

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

// Art is attached to a release node, but the UI mostly holds recording ids —
// a now-playing track, a graph node. Rather than making every caller resolve
// the album first, accept either and walk to the release here.
function coverForNode(db: Database.Database, nodeId: number) {
  const direct = resolveCover(db, nodeId);
  if (direct) return direct;

  const viaRelease = coverTargetNode(db, nodeId);
  return viaRelease === nodeId ? null : resolveCover(db, viaRelease);
}

export function coverRoutes(db: Database.Database) {
  return async function routes(app: FastifyInstance) {
    app.get<{ Params: { id: string }; Querystring: { size?: string } }>(
      "/nodes/:id/cover",
      async (request, reply) => {
        const nodeId = Number(request.params.id);
        if (!Number.isInteger(nodeId)) {
          reply.code(400);
          return { error: "invalid node id" };
        }

        const size: CoverSize = request.query.size === "full" ? "full" : "thumb";
        const cover = coverForNode(db, nodeId);
        if (!cover) {
          reply.code(404);
          return { error: "no cover art for node" };
        }

        const bytes = await readCover(cover.hash, size);
        if (!bytes) {
          // Row exists but the blob is gone — a hand-cleared cache, or a
          // half-finished write. Reported distinctly from "no art" so it is
          // debuggable rather than looking like an album that never had a cover.
          reply.code(404);
          return { error: "cover art missing from cache", hash: cover.hash };
        }

        // Cached art is immutable: the filename *is* the content hash, so a
        // different cover means a different URL. The node id in the path is
        // not, hence ETag on the hash rather than a bare long max-age.
        reply.header("Content-Type", "image/jpeg");
        reply.header("ETag", `"${cover.hash}-${size}"`);
        reply.header("Cache-Control", "private, max-age=86400");
        reply.header("X-Cover-Source", cover.source);
        return reply.send(bytes);
      },
    );

    // Manual override. Beats every automatic source for this node, permanently
    // — nothing in the scan path can displace it, which is the point.
    app.post<{ Params: { id: string } }>("/nodes/:id/cover", async (request, reply) => {
      const nodeId = Number(request.params.id);
      if (!Number.isInteger(nodeId)) {
        reply.code(400);
        return { error: "invalid node id" };
      }

      const exists = db.prepare("SELECT id FROM nodes WHERE id = ?").get(nodeId);
      if (!exists) {
        reply.code(404);
        return { error: "node not found" };
      }

      const body = request.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        reply.code(400);
        return { error: "expected raw image bytes as the request body" };
      }
      if (body.length > MAX_UPLOAD_BYTES) {
        reply.code(413);
        return { error: "cover art too large" };
      }

      let hash: string;
      try {
        hash = await storeCover(body);
      } catch {
        // storeCover only fails when ffmpeg cannot decode the bytes, which
        // for a user-supplied upload means "that was not an image".
        reply.code(400);
        return { error: "could not decode image" };
      }

      recordCover(db, {
        nodeId,
        source: "manual",
        hash,
        mime: request.headers["content-type"] ?? null,
      });

      reply.code(201);
      return { nodeId, source: "manual", hash };
    });

    app.delete<{ Params: { id: string } }>("/nodes/:id/cover", async (request, reply) => {
      const nodeId = Number(request.params.id);
      if (!Number.isInteger(nodeId)) {
        reply.code(400);
        return { error: "invalid node id" };
      }

      // Only ever removes the manual override — reverting to whatever the
      // scan found, rather than deleting art we would just rediscover.
      const result = db
        .prepare("DELETE FROM cover_art WHERE node_id = ? AND source = 'manual'")
        .run(nodeId);

      if (result.changes === 0) {
        reply.code(404);
        return { error: "no manual cover to remove" };
      }
      reply.code(204);
      return null;
    });
  };
}
