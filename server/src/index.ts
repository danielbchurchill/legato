import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { openDb } from "./db.js";
import { PORT, DATA_DIR } from "./config.js";
import { FFMPEG_PATH, FPCALC_PATH } from "./mediaBinaries.js";
import { acquireMediaSlot } from "./media/queue.js";
import { healthRoutes } from "./routes/health.js";
import { settingsRoutes } from "./routes/settings.js";
import { libraryRootsRoutes } from "./routes/library-roots.js";
import { scanRoutes } from "./routes/scan.js";
import { nodesRoutes } from "./routes/nodes.js";
import { mergeOverridesRoutes } from "./routes/merge-overrides.js";
import { favouritesRoutes } from "./routes/favourites.js";
import { playlistsRoutes } from "./routes/playlists.js";
import { layoutRoutes } from "./routes/layout.js";
import { edgesRoutes } from "./routes/edges.js";
import { searchRoutes } from "./routes/search.js";
import { wsRoutes } from "./routes/ws.js";
import { enrichRoutes } from "./routes/enrich.js";
import { filesRoutes } from "./routes/files.js";
import { queueRoutes } from "./routes/queue.js";
import { hygieneRoutes } from "./routes/hygiene.js";
import { tagWritesRoutes } from "./routes/tag-writes.js";
import { coverRoutes } from "./routes/cover.js";
import { playsRoutes } from "./routes/plays.js";
import { statsRoutes } from "./routes/stats.js";
import { dbInspectorRoutes } from "./routes/db-inspector.js";
import { similarityRoutes } from "./routes/similarity.js";
import { waveformRoutes } from "./routes/waveform.js";
import { lyricsRoutes } from "./routes/lyrics.js";
import { tagManagerRoutes } from "./routes/tag-manager.js";
import { authRoutes } from "./routes/auth.js";
import { watchLibraryRoot } from "./scan/watcher.js";
import { runDueJobs } from "./enrich/worker.js";

const db = openDb();

const app = Fastify({ logger: true });

// The #1 support question this app generates on itself: standalone runs
// (`npm --prefix server run dev` without LEGATO_DATA_DIR) silently open a
// second, empty database next to the real one Tauri points at — a "healthy"
// server reporting zero of everything. Logging the resolved path and count
// up front turns that into a one-line diagnosis instead of a debugging session.
{
  const dbPath = path.join(DATA_DIR, "legato.db");
  const { count: fileCount } = db.prepare("SELECT COUNT(*) AS count FROM files").get() as {
    count: number;
  };
  app.log.info(`database: ${dbPath} (${fileCount} files)`);
}

// Same one-line-diagnosis reasoning as the database log above: if a
// packaged build silently falls back to PATH resolution instead of the
// bundled binaries it should be finding, this is where that shows up.
app.log.info(`ffmpeg: ${FFMPEG_PATH}, fpcalc: ${FPCALC_PATH}`);

// @fastify/cors's actual default methods list is just GET,HEAD,POST — PUT/
// PATCH/DELETE are silently preflight-rejected by the browser otherwise.
// Real bug hit live: PATCH /nodes/:id/position failed with a bare
// "TypeError: Failed to fetch" from the browser (the server-side route
// itself was always fine — curl bypasses preflight entirely, which is
// exactly why this needs testing in an actual browser, not just curl).
// credentials: true (paired with reflecting the request's own Origin,
// which `origin: true` already does — the two must go together, since
// Access-Control-Allow-Origin: * is invalid alongside credentialed
// requests) so the frontend's fetches can carry the auth/auth.ts session
// cookie cross-origin, e.g. Vite's dev origin talking to this server's own.
await app.register(cors, {
  origin: true,
  credentials: true,
  methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
});
await app.register(cookie);
await app.register(websocket);

// Manual cover-art uploads arrive as raw image bytes. Fastify only knows how
// to parse JSON out of the box and 415s anything else, so image/* gets a
// passthrough parser that hands the route an untouched Buffer.
app.addContentTypeParser(
  /^image\/.*/,
  { parseAs: "buffer", bodyLimit: 20 * 1024 * 1024 },
  (_request, body, done) => done(null, body),
);

await app.register(healthRoutes(), { prefix: "/api/v1" });
await app.register(settingsRoutes(db), { prefix: "/api/v1" });
await app.register(libraryRootsRoutes(db), { prefix: "/api/v1" });
await app.register(scanRoutes(db), { prefix: "/api/v1" });
await app.register(nodesRoutes(db), { prefix: "/api/v1" });
await app.register(mergeOverridesRoutes(db), { prefix: "/api/v1" });
await app.register(favouritesRoutes(db), { prefix: "/api/v1" });
await app.register(playlistsRoutes(db), { prefix: "/api/v1" });
await app.register(layoutRoutes(db), { prefix: "/api/v1" });
await app.register(edgesRoutes(db), { prefix: "/api/v1" });
await app.register(searchRoutes(db), { prefix: "/api/v1" });
await app.register(wsRoutes(), { prefix: "/api/v1" });
await app.register(enrichRoutes(db), { prefix: "/api/v1" });
await app.register(filesRoutes(db), { prefix: "/api/v1" });
await app.register(queueRoutes(db), { prefix: "/api/v1" });
await app.register(hygieneRoutes(db), { prefix: "/api/v1" });
await app.register(tagWritesRoutes(db), { prefix: "/api/v1" });
await app.register(coverRoutes(db), { prefix: "/api/v1" });
await app.register(playsRoutes(db), { prefix: "/api/v1" });
await app.register(statsRoutes(db), { prefix: "/api/v1" });
await app.register(dbInspectorRoutes(db), { prefix: "/api/v1" });
await app.register(similarityRoutes(db), { prefix: "/api/v1" });
await app.register(waveformRoutes(db), { prefix: "/api/v1" });
await app.register(lyricsRoutes(db), { prefix: "/api/v1" });
await app.register(tagManagerRoutes(db), { prefix: "/api/v1" });
await app.register(authRoutes(db), { prefix: "/api/v1" });

// Resume watching every already-configured root across restarts — a root
// added in a previous session shouldn't need a manual re-scan to notice
// files that changed while the server was down. (A full catch-up scan of
// changes made while offline is still a manual POST /scan for now — the
// watcher only sees events that occur while it's running.)
for (const root of db
  .prepare("SELECT id, path FROM library_roots WHERE enabled = 1")
  .all() as { id: number; path: string }[]) {
  watchLibraryRoot(db, root.id, root.path);
}

// Persistent queue, not a fire-and-forget in-memory one: enrich_jobs rows
// survive a restart, and this poller just needs to notice them again — no
// separate "resume the queue" step required. mbClient.ts's own throttle
// keeps every tick's requests at ~1req/sec regardless of how many jobs
// are due.
const ENRICH_POLL_INTERVAL_MS = 5000;
setInterval(() => {
  void runDueJobs(db);
}, ENRICH_POLL_INTERVAL_MS);

// --- THE SPIKE (debug-only smoke test routes, kept alive for src/PlaybackSpike.tsx) ---
//
// Real recursive folder scan + tag extraction lands in M1; these two routes
// still do the original flat-readdir/ffmpeg-passthrough spike behavior, but
// now read their root from the first enabled library_roots row instead of a
// hardcoded default — no shipped code should point at one specific machine's
// folder layout. If no root is configured yet, they fail closed.
function activeLibraryRoot(): string | null {
  const row = db
    .prepare("SELECT path FROM library_roots WHERE enabled = 1 ORDER BY id LIMIT 1")
    .get() as { path: string } | undefined;
  return row?.path ?? null;
}

app.get("/tracks", async (_request, reply) => {
  const root = activeLibraryRoot();
  if (!root) {
    reply.code(503);
    return { error: "no library root configured" };
  }
  const entries = await readdir(root);
  return entries.filter((f) => f.toLowerCase().endsWith(".flac")).sort();
});

app.get<{ Params: { filename: string } }>("/stream/:filename", async (request, reply) => {
  const root = activeLibraryRoot();
  if (!root) {
    reply.code(503);
    return { error: "no library root configured" };
  }

  const filename = decodeURIComponent(request.params.filename);
  const resolved = path.resolve(root, filename);

  if (!resolved.startsWith(root + path.sep)) {
    reply.code(400);
    return { error: "invalid filename" };
  }

  // Issue #111: this bare spawn is #98's to rewrite properly (it's the
  // route that trusts a client-supplied filename directly — see
  // routes/files.ts's own comment on why it exists only for the debug
  // spike now), so the edit here is deliberately narrow: just give this
  // spawn a playback-priority slot in the shared media queue, same as the
  // real GET /files/:id/stream route (stream/cache.ts's ensureCached), so
  // a scan's background ffmpeg work can't starve this one either.
  const release = await acquireMediaSlot("playback");

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

  // Released once this spawn is actually done, not once this handler
  // returns — the handler hands the stream to reply.send() and returns
  // long before ffmpeg exits. release() is idempotent, so both 'close'
  // and 'error' firing is harmless.
  ffmpeg.on("close", release);
  ffmpeg.on("error", release);

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
  app.log.info(`legato-server listening at ${address}`);
});
