import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { ensureCached } from "../stream/cache.js";

// Resolves an opaque numeric file id to a path server-side — the client
// never sees or supplies a raw filesystem path. This is the concrete fix
// for a real bug found in a competitor (Feishin): its tag editor took a
// server-reported path and tried to open it directly on the *client's own*
// filesystem, which only works by accident when client and server happen
// to share one — false the instant they're on different machines, exactly
// the case this split-service architecture exists to support. The old
// /stream/:filename spike (server/src/index.ts) trusted a client-supplied
// filename directly; this route is what replaces it for real playback.
export function filesRoutes(db: Database.Database) {
  return async function routes(app: FastifyInstance) {
    app.get<{ Params: { id: string } }>("/files/:id/stream", async (request, reply) => {
      const file = db
        .prepare("SELECT file_path, file_hash, missing_since FROM files WHERE id = ?")
        .get(request.params.id) as
        | { file_path: string; file_hash: string | null; missing_since: string | null }
        | undefined;

      if (!file || file.missing_since) {
        reply.code(404);
        return { error: "file not found" };
      }

      // file_hash is populated by the scanner for every real row — only
      // something inserted outside the scan path could lack one, which
      // would itself be a bug worth surfacing rather than transcoding
      // without a cache key.
      if (!file.file_hash) {
        reply.code(500);
        return { error: "file has no content hash, cannot cache a transcode" };
      }

      let cached: string;
      try {
        cached = await ensureCached(file.file_hash, file.file_path);
      } catch (err) {
        request.log.error(err);
        reply.code(502);
        return { error: "transcode failed" };
      }

      const { size } = await stat(cached);
      const range = parseRange(request.headers.range, size);

      reply.header("Content-Type", "audio/flac");
      reply.header("Accept-Ranges", "bytes");
      // Content-addressed by file_hash, same reasoning as GET /covers/:hash
      // — the bytes at this cache path never change, so the browser can
      // hold onto them indefinitely instead of re-fetching on every seek.
      reply.header("Cache-Control", "private, max-age=31536000, immutable");

      if (range) {
        reply.code(206);
        reply.header("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
        reply.header("Content-Length", range.end - range.start + 1);
        return reply.send(createReadStream(cached, { start: range.start, end: range.end }));
      }

      reply.header("Content-Length", size);
      return reply.send(createReadStream(cached));
    });
  };
}

// Single-range `bytes=start-end` only (including the open-ended `bytes=0-`
// and suffix `bytes=-500` forms) — every real audio/video client sends
// exactly one of these. A multi-range request, or anything malformed, falls
// through to `null`, which the route above turns into a plain 200 with the
// whole file: ignoring Range entirely is valid per RFC 7233, and correct is
// more important here than clever.
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null {
  if (!header?.startsWith("bytes=")) return null;

  const spec = header.slice(6);
  if (spec.includes(",")) return null; // multi-range: not worth supporting

  const [startStr, endStr] = spec.split("-");
  if (startStr === undefined) return null;

  let start: number;
  let end: number;

  if (startStr === "") {
    // Suffix form: "bytes=-500" means the last 500 bytes.
    const suffixLength = Number(endStr);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(startStr);
    end = endStr === "" || endStr === undefined ? size - 1 : Number(endStr);
  }

  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start < 0 || end >= size || start > end) return null;

  return { start, end };
}
