import { spawn } from "node:child_process";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";

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
        .prepare("SELECT file_path, missing_since FROM files WHERE id = ?")
        .get(request.params.id) as { file_path: string; missing_since: string | null } | undefined;

      if (!file || file.missing_since) {
        reply.code(404);
        return { error: "file not found" };
      }

      // Decode the source to PCM and re-encode to FLAC — one transport
      // format for every client regardless of source codec.
      const ffmpeg = spawn("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        file.file_path,
        "-map",
        "0:a:0",
        "-f",
        "flac",
        "-compression_level",
        "5",
        "pipe:1",
      ]);

      ffmpeg.stderr.on("data", (chunk: Buffer) => {
        request.log.warn(chunk.toString());
      });

      request.raw.on("close", () => {
        if (!ffmpeg.killed) ffmpeg.kill("SIGTERM");
      });

      reply.header("Content-Type", "audio/flac");
      reply.header("Cache-Control", "no-store");
      return reply.send(ffmpeg.stdout);
    });
  };
}
