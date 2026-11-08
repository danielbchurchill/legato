import type { Database } from "../sqlite.js";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  CandidateFetchError,
  coverSubject,
  fetchCandidateImage,
  fetchCandidateThumb,
  isCandidateId,
  listCandidates,
  type CandidateSource,
} from "../cover/candidates.js";
import { coverDependents, recordCover, resolveCover, resolveCoverForNode } from "../cover/extract.js";
import { readCover, storeCover } from "../cover/store.js";
import type { CoverSize } from "../cover/store.js";
import { isEnrichmentEnabled } from "../enrich/queue.js";
import { unreadablePictureMessage } from "../media/pipedImage.js";
import { broadcast } from "../ws.js";

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

const SOURCE_NAME: Record<CandidateSource, string> = { caa: "The Cover Art Archive", deezer: "Deezer" };

// A cover chosen, uploaded or reset (#461). enrich:applied is what the map's
// graph already refetches on (canvas/useGraphData.ts), and what an open
// details panel reloads its node on, so both pick up the new cover_hash.
// /nodes/:id/cover is the same URL either side of the change, so `nodeIds`
// names every node showing this art (its tracks, an artist borrowing it),
// whose images the client asks for again (src/ui/coverVersion.ts).
function coverChanged(db: Database, nodeId: number): void {
  broadcast("enrich:applied", { nodeId, kind: "cover", nodeIds: coverDependents(db, nodeId) });
}

// The picker's lookups are online lookups, under the same switch as the
// enrichment queue's: off means no device's request reaches the Cover Art
// Archive, MusicBrainz or Deezer through this server.
function refuseOffline(db: Database, reply: FastifyReply): { error: string } | null {
  if (isEnrichmentEnabled(db)) return null;
  reply.code(403);
  return { error: "Looking up metadata online is off" };
}

// Aborted when the client goes away before the answer is sent: the picker
// closed, so the lookup it asked for stops rather than finishing unseen.
function abortOnHangUp(reply: FastifyReply): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const onClose = () => {
    if (!reply.raw.writableEnded) controller.abort();
  };
  reply.raw.on("close", onClose);
  return { signal: controller.signal, done: () => reply.raw.off("close", onClose) };
}

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
      } catch (err) {
        // storeCover only fails when the bytes aren't a picture: refused
        // before ffmpeg starts (#477), or ffmpeg couldn't decode them. For a
        // user-supplied upload, either means "that was not an image".
        reply.code(400);
        return { error: unreadablePictureMessage(err) };
      }

      recordCover(db, {
        nodeId,
        source: "manual",
        hash,
        mime: request.headers["content-type"] ?? null,
      });
      coverChanged(db, nodeId);

      reply.code(201);
      return { nodeId, source: "manual", hash };
    });

    // What the cover picker needs before it looks anything up (#461):
    // whether it may (the "Look up metadata online" switch), whether there's
    // an album to search for, whether the cover is a manual choice that
    // "Use the automatic cover" would remove, and what shows it.
    app.get<{ Params: { id: string } }>("/nodes/:id/cover/picker", async (request, reply) => {
      const nodeId = Number(request.params.id);
      if (!Number.isInteger(nodeId)) {
        reply.code(400);
        return { error: "invalid node id" };
      }
      if (!db.prepare("SELECT id FROM nodes WHERE id = ?").get(nodeId)) {
        reply.code(404);
        return { error: "node not found" };
      }
      const subject = coverSubject(db, nodeId);
      return {
        nodeId,
        online: isEnrichmentEnabled(db),
        searchable: subject != null,
        manual: resolveCover(db, nodeId)?.source === "manual",
        title: subject?.title ?? null,
        artist: subject?.artist ?? null,
        // The nodes showing this cover, for the picker to refresh at once
        // after a change rather than wait for the broadcast.
        nodeIds: coverDependents(db, nodeId),
      };
    });

    // One source's candidates for an album's cover. `all=1` asks the Cover
    // Art Archive for every image of every edition, not only the fronts
    // and backs, which takes a request per edition.
    app.get<{ Params: { id: string }; Querystring: { source?: string; all?: string } }>(
      "/nodes/:id/cover/candidates",
      async (request, reply) => {
        const nodeId = Number(request.params.id);
        const source = request.query.source;
        if (!Number.isInteger(nodeId) || (source !== "caa" && source !== "deezer")) {
          reply.code(400);
          return { error: "expected a node id and source=caa or source=deezer" };
        }
        const offline = refuseOffline(db, reply);
        if (offline) return offline;
        if (!db.prepare("SELECT id FROM nodes WHERE id = ?").get(nodeId)) {
          reply.code(404);
          return { error: "node not found" };
        }
        const subject = coverSubject(db, nodeId);
        if (!subject) {
          reply.code(400);
          return { error: "only an album's cover can be looked up" };
        }

        const hangUp = abortOnHangUp(reply);
        try {
          return await listCandidates(subject, source, { everything: request.query.all === "1", signal: hangUp.signal });
        } catch (err) {
          if (hangUp.signal.aborted) return reply.code(499).send();
          request.log.warn({ err, nodeId, source }, "cover candidate lookup failed");
          reply.code(502);
          return { error: `${SOURCE_NAME[source]} didn't answer` };
        } finally {
          hangUp.done();
        }
      },
    );

    // A candidate's thumbnail, fetched by the server so no device contacts
    // the Cover Art Archive or Deezer itself. The id names the image (see
    // cover/candidates.ts); a URL is never taken from the client.
    app.get<{ Params: { candidate: string } }>("/cover-candidates/:candidate/thumb", async (request, reply) => {
      const { candidate } = request.params;
      if (!isCandidateId(candidate)) {
        reply.code(400);
        return { error: "invalid candidate" };
      }
      const offline = refuseOffline(db, reply);
      if (offline) return offline;
      try {
        const image = await fetchCandidateThumb(candidate);
        if (!image) {
          reply.code(404);
          return { error: "no such image" };
        }
        reply.header("Content-Type", image.mime);
        // The id names one image, which its source doesn't change under it.
        reply.header("Cache-Control", "private, max-age=86400");
        return reply.send(image.bytes);
      } catch (err) {
        request.log.warn({ err, candidate }, "cover candidate thumbnail failed");
        reply.code(502);
        return { error: "the image's source didn't answer" };
      }
    });

    // Choosing a candidate: the server fetches the full image and keeps it
    // as the node's manual cover, exactly as an upload is kept. Nothing is
    // written into the music files. origin_path records where it came from.
    app.post<{ Params: { id: string }; Body: { candidate?: unknown } }>(
      "/nodes/:id/cover/candidate",
      async (request, reply) => {
        const nodeId = Number(request.params.id);
        const candidate = request.body?.candidate;
        if (!Number.isInteger(nodeId) || typeof candidate !== "string" || !isCandidateId(candidate)) {
          reply.code(400);
          return { error: "expected a node id and a candidate" };
        }
        const offline = refuseOffline(db, reply);
        if (offline) return offline;
        if (!db.prepare("SELECT id FROM nodes WHERE id = ?").get(nodeId)) {
          reply.code(404);
          return { error: "node not found" };
        }

        let image;
        try {
          image = await fetchCandidateImage(candidate);
        } catch (err) {
          request.log.warn({ err, candidate }, "cover candidate fetch failed");
          reply.code(502);
          return { error: err instanceof CandidateFetchError ? err.message : "the image's source didn't answer" };
        }
        if (!image) {
          reply.code(404);
          return { error: "the image is no longer there" };
        }

        let hash: string;
        try {
          hash = await storeCover(image.bytes);
        } catch {
          reply.code(502);
          return { error: "could not decode image" };
        }
        recordCover(db, { nodeId, source: "manual", hash, mime: image.mime, originPath: image.url });
        coverChanged(db, nodeId);

        reply.code(201);
        return { nodeId, source: "manual", hash };
      },
    );

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
      coverChanged(db, nodeId);
      reply.code(204);
      return null;
    });
  };
}
