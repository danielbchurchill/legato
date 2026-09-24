import type { Database } from "../sqlite.js";
import type { FastifyInstance } from "fastify";
import { recordCover, resolveCoverForNode } from "../cover/extract.js";
import { readCover, storeCover } from "../cover/store.js";
import type { CoverSize } from "../cover/store.js";

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

// The cache key is a sha1 of the original bytes and the only thing that ever
// reaches the filesystem through the by-hash route below — anchored, fixed
// length, hex only, so no request can walk out of the cover cache directory.
const HASH_PATTERN = /^[0-9a-f]{40}$/;

export function coverRoutes(db: Database) {
  return async function routes(app: FastifyInstance) {
    // Art by content hash rather than by node.
    //
    // Every recording on an album resolves to the same cover, so the
    // per-node URL gave a twelve-track release twelve distinct URLs for one
    // image. The browser cached each separately, and — the reason this route
    // exists at all — sigma's texture atlas keys on the image URL, so it
    // held twelve copies of the same texture. That is what made rendering
    // art on track nodes prohibitive (Canvas.tsx's old LOD gate) and what
    // capped how many texels each cover could afford. Content-addressed, an
    // album's art is one URL, one cached response and one atlas entry
    // however many nodes display it.
    app.get<{ Params: { hash: string }; Querystring: { size?: string } }>(
      "/covers/:hash",
      async (request, reply) => {
        const { hash } = request.params;
        if (!HASH_PATTERN.test(hash)) {
          reply.code(400);
          return { error: "invalid cover hash" };
        }

        const size: CoverSize = request.query.size === "full" ? "full" : "thumb";
        const bytes = await readCover(hash, size);
        if (!bytes) {
          reply.code(404);
          return { error: "cover art missing from cache", hash };
        }

        reply.header("Content-Type", "image/jpeg");
        reply.header("ETag", `"${hash}-${size}"`);
        // A year and immutable, unlike the node route's one day: the URL
        // names the content, so these bytes can never become the wrong
        // answer for it. Still private — a cover cache is derived from a
        // personal library, and nothing in front of this server should be
        // fanning it out to other people.
        reply.header("Cache-Control", "private, max-age=31536000, immutable");
        return reply.send(bytes);
      },
    );

    // Art by node — for callers holding an id rather than a hash (the panels,
    // which render whatever node is selected). Accepts any node type and
    // walks to whatever actually carries the art, so a now-playing recording
    // resolves to its album's cover without the client knowing that art
    // attaches to the release.
    app.get<{ Params: { id: string }; Querystring: { size?: string } }>(
      "/nodes/:id/cover",
      async (request, reply) => {
        const nodeId = Number(request.params.id);
        if (!Number.isInteger(nodeId)) {
          reply.code(400);
          return { error: "invalid node id" };
        }

        const size: CoverSize = request.query.size === "full" ? "full" : "thumb";
        const cover = resolveCoverForNode(db, nodeId);
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
