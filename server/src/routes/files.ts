import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { Database } from "../sqlite.js";
import type { FastifyInstance, FastifyReply } from "fastify";
import { streamActivity, type StreamActivity } from "../stream/activity.js";
import { CACHE_DIR, ensureVariant, readGrowing } from "../stream/cache.js";
import {
  isStreamQuality,
  passthroughContentType,
  STREAM_QUALITIES,
  VARIANTS,
} from "../stream/quality.js";

// Resolves an opaque numeric file id to a path server-side — the client
// never sees or supplies a raw filesystem path. This is the concrete fix
// for a real bug found in a competitor (Feishin): its tag editor took a
// server-reported path and tried to open it directly on the *client's own*
// filesystem, which only works by accident when client and server happen
// to share one — false the instant they're on different machines, exactly
// the case this split-service architecture exists to support.
//
// Issue #120: `?quality=` picks a rung of the ladder (stream/quality.ts).
// Absent means `original`, so a client that predates the ladder keeps
// getting full-quality audio, now straight from the source file rather than
// a FLAC re-encode of it.
//
// Every audio body goes out through `activity.meter` (issue #130), which is
// how the desktop shell knows this server is streaming and keeps the
// computer awake for it. See stream/activity.ts.
export function filesRoutes(
  db: Database,
  { cacheDir = CACHE_DIR, activity = streamActivity }: { cacheDir?: string; activity?: StreamActivity } = {},
) {
  return async function routes(app: FastifyInstance) {
    app.get<{ Params: { id: string }; Querystring: { quality?: string } }>(
      "/files/:id/stream",
      async (request, reply) => {
        const quality: unknown = request.query.quality ?? "original";
        if (!isStreamQuality(quality)) {
          reply.code(400);
          return { error: `unknown quality, expected one of: ${STREAM_QUALITIES.join(", ")}` };
        }

        const file = db
          .prepare("SELECT file_path, file_hash, missing_since FROM files WHERE id = ?")
          .get(request.params.id) as
          | { file_path: string; file_hash: string | null; missing_since: string | null }
          | undefined;

        if (!file || file.missing_since) {
          reply.code(404);
          return { error: "file not found" };
        }

        if (quality === "original") return sendOriginal(file.file_path, file.file_hash, request.headers.range, reply, activity);

        // file_hash is populated by the scanner for every real row — only
        // something inserted outside the scan path could lack one, which
        // would itself be a bug worth surfacing rather than transcoding
        // without a cache key.
        if (!file.file_hash) {
          reply.code(500);
          return { error: "file has no content hash, cannot cache a transcode" };
        }

        try {
          let variant = await ensureVariant(file.file_hash, file.file_path, quality, cacheDir);
          if (variant.kind === "growing") {
            // A first byte (or an early failure) before any header goes
            // out, so a source ffmpeg can't read is still a clean 502.
            await variant.job.started;
            if (!startsFromZero(request.headers.range)) {
              // A seek into an encode still under way: the byte it wants
              // may not exist yet and the total length isn't known, so
              // there's no honest 206 to give until the file is whole. A
              // plain play from the top never takes this branch.
              await variant.job.finished;
              variant = { kind: "complete", path: variant.job.targetPath };
            }
          }

          // Content-addressed by file_hash and quality, same reasoning as
          // GET /covers/:hash — the bytes of a finished variant never
          // change, so the browser can hold onto them instead of
          // re-fetching on every seek.
          const headers = {
            "Content-Type": VARIANTS[quality].contentType,
            "Cache-Control": "private, max-age=31536000, immutable",
          };

          if (variant.kind === "growing") {
            // No Content-Length: the encode is still writing, so the length
            // isn't known yet and the body goes out chunked. Accept-Ranges
            // still advertises the seekable file this becomes. TTFA is the
            // whole point of #120's quality ladder: audio starts
            // as soon as ffmpeg's first chunk lands, not when it exits.
            reply.headers({ ...headers, "Accept-Ranges": "bytes" });
            return reply.send(activity.meter(Readable.from(readGrowing(variant.job))));
          }
          return await sendFile(variant.path, request.headers.range, reply, headers, activity);
        } catch (err) {
          request.log.error(err);
          reply.code(502);
          return { error: `transcode to ${quality} failed` };
        }
      },
    );
  };
}

// #120's "Original": the source file as it sits on disk, never transcoded —
// FLAC passthrough for the real library, and whatever container a non-FLAC
// source already uses otherwise. Not cached: the file is already here.
async function sendOriginal(
  filePath: string,
  fileHash: string | null,
  rangeHeader: string | undefined,
  reply: FastifyReply,
  activity: StreamActivity,
) {
  // Unlike a transcode variant this URL isn't content-addressed: a tag
  // write rewrites these bytes in place under the same file id. The ETag
  // (the scanner's content hash) lets a browser keep its copy until then;
  // no-cache makes it ask first.
  const headers: Record<string, string> = {
    "Content-Type": passthroughContentType(path.extname(filePath)),
    "Cache-Control": "private, no-cache",
  };
  if (fileHash) headers.ETag = `"${fileHash}"`;
  try {
    return await sendFile(filePath, rangeHeader, reply, headers, activity);
  } catch (err) {
    // Gone from disk since the last scan noticed (unmounted drive, file
    // moved): the row's missing_since hasn't caught up yet.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      reply.code(404);
      return { error: "file not found on disk" };
    }
    throw err;
  }
}

// `headers` (the audio Content-Type among them) go out only with audio
// bytes: Fastify refuses to serialize a JSON error body under an audio/*
// type, so the 416 and any thrown error keep the default instead.
async function sendFile(
  filePath: string,
  rangeHeader: string | undefined,
  reply: FastifyReply,
  headers: Record<string, string>,
  activity: StreamActivity,
) {
  const { size } = await stat(filePath);
  const range = parseRange(rangeHeader, size);
  reply.header("Accept-Ranges", "bytes");

  if (range === "unsatisfiable") {
    reply.code(416);
    reply.header("Content-Range", `bytes */${size}`);
    return { error: "requested range not satisfiable" };
  }

  reply.headers(headers);

  if (range) {
    reply.code(206);
    reply.header("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
    reply.header("Content-Length", range.end - range.start + 1);
    return reply.send(activity.meter(createReadStream(filePath, { start: range.start, end: range.end })));
  }

  reply.header("Content-Length", size);
  return reply.send(activity.meter(createReadStream(filePath)));
}

// What a browser sends to start playback from the top: no Range at all, or
// the open-ended `bytes=0-` Chrome and Firefox use.
function startsFromZero(header: string | undefined): boolean {
  return header === undefined || header.trim() === "bytes=0-";
}

// Single-range `bytes=start-end` only (including the open-ended `bytes=0-`
// and suffix `bytes=-500` forms) — every real audio/video client sends
// exactly one of these. A multi-range request, or anything malformed, falls
// through to `null`, which the route above turns into a plain 200 with the
// whole file: ignoring Range entirely is valid per RFC 7233, and correct is
// more important here than clever.
//
// A well-formed range that starts past the end of the file is
// "unsatisfiable" (416, RFC 7233 §4.4); an end past it is clamped to the
// last byte, as the RFC asks, rather than refused.
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | "unsatisfiable" | null {
  if (!header?.startsWith("bytes=")) return null;

  const spec = header.slice(6);
  if (spec.includes(",")) return null; // multi-range: not worth supporting

  const [startStr, endStr] = spec.split("-");
  if (startStr === undefined || endStr === undefined) return null;

  if (startStr === "") {
    // Suffix form: "bytes=-500" means the last 500 bytes.
    const suffixLength = Number(endStr);
    if (endStr === "" || !Number.isInteger(suffixLength) || suffixLength < 0) return null;
    if (suffixLength === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(startStr);
  const end = endStr === "" ? Infinity : Number(endStr);
  if (!Number.isInteger(start) || start < 0) return null;
  if (end !== Infinity && (!Number.isInteger(end) || end < start)) return null;
  if (start >= size) return "unsatisfiable";

  return { start, end: Math.min(end, size - 1) };
}
