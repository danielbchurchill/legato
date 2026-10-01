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
import { installAuthGate, redactCredentials } from "./auth/gate.js";
import { registerRoutes } from "./routes/register.js";
import { setupCodes } from "./auth/setupCode.js";
import { ownerExists } from "./auth/owner.js";
import { installLegatoIdentity, LegatoIdentity } from "./auth/legatoIdentity.js";
import { webClientRoutes } from "./routes/web-client.js";
import { watchLibraryRoot } from "./scan/watcher.js";
import { reconcileInterruptedScans } from "./scan/scanner.js";
import { backfillFuzzyIndex } from "./match/backfill-fuzzy-index.js";
import { runDueJobs } from "./enrich/worker.js";
import { GIT_SHA, VERSION } from "./version.js";
import { startUpdateChecks } from "./update/check.js";

// Checked before anything else touches disk (openDb below creates the data
// dir and runs migrations) — `legato-server --version` should work without
// needing a real LEGATO_DATA_DIR, the same way `--help`/`--version` work on
// any other CLI tool. Plain `.includes()` rather than a real argv parser:
// this is the only flag the binary takes.
if (process.argv.includes("--version") || process.argv.includes("-v")) {
  console.log(`legato-server ${VERSION} (${GIT_SHA})`);
  process.exit(0);
}

// Fastify's default request serializer, except the URL: media tickets
// (issue #112, auth/gate.ts) ride in query strings, and every cover
// thumbnail would otherwise write a working credential into the log.
const app = Fastify({
  logger: {
    serializers: {
      req: (request) => ({
        method: request.method,
        url: redactCredentials(request.url),
        host: request.host,
        remoteAddress: request.ip,
        remotePort: request.socket?.remotePort,
      }),
    },
  },
});
app.log.info(`legato-server ${VERSION} (${GIT_SHA})`);

// The logger comes up before openDb() so the pre-migration backup line
// (issue #191) lands with the rest of startup, and so a backup that can't
// be written ends in one readable fatal line rather than a stack trace.
// openDb() has already refused to migrate by the time it throws.
let db: ReturnType<typeof openDb>;
try {
  db = openDb(undefined, { log: (message) => app.log.info(message) });
} catch (err) {
  app.log.fatal(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

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

// Issue #112: until an owner exists, every route but /health refuses to
// answer, and anyone creating the owner from another machine (the Mac
// talking to the Pi, a browser on the LAN) has to send the setup code. #113
// shows it on the /setup page too, and replaces it every ten minutes; each
// new one is logged here as well, at warn level so it stands out among the
// startup lines in journalctl or docker logs, for whoever reads the log
// instead of opening the page. Both stop once an owner exists.
if (!ownerExists(db)) {
  setupCodes.onIssue(({ code }, replaced) => {
    if (ownerExists(db)) return;
    app.log.warn(
      replaced
        ? `Setup code ${replaced} expired — the new one is ${code}, valid for 10 minutes.`
        : `No owner account yet — setup code ${code}, valid for 10 minutes. Open http://<this server>:${PORT}/setup ` +
            "in a browser on your network, or create the owner in the Legato app; from another machine it asks for this code.",
    );
  });
  setupCodes.scheduleRefresh(() => !ownerExists(db));
  // Seam for the legato.fm half of plan 02's claim (step 4), a follow-up
  // to #113 waiting on #215 and #114: each code issued above would also be
  // offered to the relay's POST /pair/exchange every few seconds until it
  // expires, so a phone that scanned the /setup QR and claimed it on
  // legato.fm pairs this server with no typing. That needs the tunnel
  // client and somewhere to keep its credential, which don't exist yet.
}

// Issue #123 (D17): a scan_jobs row stuck at status='running' means the
// server died mid-scan — nothing is actually running it. Reconciled to
// 'paused' before anything else starts, so "pause survives a restart"
// holds even for a restart nobody asked for, and a client that comes back
// later sees a resumable job instead of one that looks alive forever.
{
  const reconciled = reconcileInterruptedScans(db);
  if (reconciled > 0) app.log.info(`scan: reconciled ${reconciled} interrupted run(s) to paused`);
}

// Issue #173 follow-up: migration 0028 adds normalized_title/normalized_artist
// as NULL for rows that already existed, and an unchanged file never reaches
// tryFuzzyMatch again to self-heal them (mtime/size short-circuits scanFile()
// in scanner.ts) — so an in-place upgrade would silently lose fuzzy matching
// for its whole pre-existing unmatched/fuzzy_pending pool. Since #102/#103
// the server ships as a compiled binary the Tauri shell spawns as a sidecar,
// with no npm or server/ directory on the end user's machine, so this can't
// be a manual CLI step; it has to happen here, on every start. Cheap once a
// library is caught up — the query only matches rows still missing their
// normalized columns, which is none of them after the first run.
{
  const fuzzyIndexed = backfillFuzzyIndex(db);
  if (fuzzyIndexed > 0) app.log.info(`match: backfilled fuzzy-match index columns for ${fuzzyIndexed} file(s)`);
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

// Issue #112: the owner gate goes on before any route exists, so every
// route registered after it (registerRoutes below, and anything added
// straight to `app` later in this file) is behind it. auth/gate.ts has the
// rules.
installAuthGate(app, db);
await registerRoutes(app, db);

// Issue #114: legato.fm's signing keys. syncSchedule() starts the daily
// refresh only if an account is already linked; an unlinked server makes
// no contact with legato.fm at all (auth/legatoIdentity.ts).
{
  const identity = new LegatoIdentity(db, {
    log: (level, message) => (level === "warn" ? app.log.warn(message) : app.log.info(message)),
  });
  installLegatoIdentity(db, identity);
  identity.syncSchedule();
  app.log.info(
    identity.enabled
      ? `legato.fm: server id ${identity.serverId()}, trusting ${identity.origin}${identity.scheduled ? " (linked, refreshing keys daily)" : " (not linked, no contact)"}`
      : "legato.fm: sign-in turned off (LEGATO_ID_ORIGIN=off)",
  );
}

// #116's web client and its SPA fallback. Registered after the gate like
// everything else; auth/gate.ts lets plain GET/HEAD outside the API
// prefixes through, so the sign-in screen loads before anyone is signed in.
await app.register(webClientRoutes());

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

// Issue #110: the daily "is there a newer release" check. Never awaited, so
// GitHub being slow or unreachable can't hold up startup.
startUpdateChecks(db, (message) => app.log.info(message));

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
  // real GET /files/:id/stream route (stream/cache.ts's ensureVariant), so
  // a scan's background ffmpeg work can't starve this one either.
  const release = await acquireMediaSlot("playback");

  // Decode the source to PCM and re-encode to FLAC — one transport format
  // for every client regardless of source codec, per Legato's design.
  const ffmpeg = spawn(FFMPEG_PATH, [
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
