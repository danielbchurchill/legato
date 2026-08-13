import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import cors from "@fastify/cors";
import Fastify from "fastify";

const PORT = 8899;

// THE SPIKE: prove server-side "any source -> PCM -> FLAC" transcode +
// streaming works, before building the real scan/enrich/decode service.
const MUSIC_ROOT = path.resolve(
  process.env.LEGATO_SPIKE_MUSIC_ROOT ?? "/mnt/music/Music/The Beatles/Abbey Road",
);

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });

app.get("/tracks", async () => {
  const entries = await readdir(MUSIC_ROOT);
  return entries.filter((f) => f.toLowerCase().endsWith(".flac")).sort();
});

app.get<{ Params: { filename: string } }>("/stream/:filename", async (request, reply) => {
  const filename = decodeURIComponent(request.params.filename);
  const resolved = path.resolve(MUSIC_ROOT, filename);

  if (!resolved.startsWith(MUSIC_ROOT + path.sep)) {
    reply.code(400);
    return { error: "invalid filename" };
  }

  // Decode the source to PCM and re-encode to FLAC — one transport format
  // for every client regardless of source codec, per Legato's design.
  const ffmpeg = spawn("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    resolved,
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

app.listen({ port: PORT, host: "0.0.0.0" }, (err, address) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  app.log.info(`legato-server spike listening at ${address}`);
});
