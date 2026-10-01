import { cpus, homedir } from "node:os";
import path from "node:path";

// M-9: the first real secret this project has needed. CLAUDE.md's
// documented convention is server/.env.local, never committed — loaded
// here (the one module that actually reads process.env) rather than in
// index.ts, since ESM import hoisting means index.ts's own top-level code
// would run *after* its `import ... from "./config.js"` has already
// evaluated, too late to matter. Missing file is the expected case until
// Daniel creates one — every env var below already treats undefined as
// "feature quietly inactive", not an error.
try {
  process.loadEnvFile(path.join(import.meta.dirname, "..", ".env.local"));
} catch {
  // No .env.local yet.
}

// LEGATO_DATA_DIR is set by the Tauri shell to its per-OS app-data directory
// (src-tauri's setup hook, via app.path().app_data_dir()). The fallback below
// only matters when the server is run standalone (`npm run dev`/`start`
// outside Tauri) — real cross-platform default resolution is Tauri's job,
// not this server's, per Legato's platform split.
export const DATA_DIR = path.resolve(
  process.env.LEGATO_DATA_DIR ?? path.join(homedir(), ".local", "share", "legato"),
);

export const PORT = Number(process.env.LEGATO_PORT ?? 8899);

// M-9: AcoustID's fingerprint-lookup service needs a free client key
// (https://acoustid.org/api-key) — undefined here just means the tier 2
// fallback stays quietly inactive (enrich/acoustid.ts logs one warning
// and returns no matches), the same graceful-absence handling as fpcalc
// itself not being on PATH. Real secrets go in server/.env.local per
// CLAUDE.md, never committed — there is no .env.local in this repo yet.
export const ACOUSTID_API_KEY = process.env.ACOUSTID_API_KEY;

// Rough OAuth account provisioning (see server/src/routes/auth.ts) — the
// first secret-consuming feature in this repo that isn't a keyless
// enrichment lookup. Same convention as ACOUSTID_API_KEY above: every var
// here defaults to undefined, and auth.ts treats an unconfigured provider
// as "quietly inactive" (its two routes 503 with a clear message) rather
// than crashing the server. Register real OAuth apps at Google Cloud
// Console -> APIs & Services -> Credentials, and GitHub -> Settings ->
// Developer settings -> OAuth Apps — see server/.env.local.example for the
// exact callback URLs to register.
export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
export const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
export const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
export const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;

// Issue #111: a shared limit on how many ffmpeg/fpcalc child processes this
// server runs at once, across every call site that spawns one — playback
// transcodes (stream/cache.ts, and index.ts's spike route), cover resizing
// (cover/store.ts), waveform decode (waveform/decode.ts) and fingerprinting
// (match/fingerprint.ts), including the enrichment worker's own use of the
// latter two. media/queue.ts is what actually enforces it (and gives
// playback priority over queued background work); this is just where the
// number comes from, per CLAUDE.md's convention of documenting every env
// var in this one file.
//
// Exists for docs/plans/01-server-distribution.md's Low-power hosts case: a
// Synology "+" model's J4125-class CPU has 4 cores and 2-4GB of RAM, and a
// fresh scan's fingerprinting/cover/waveform work must never leave nothing
// for the track someone is actually listening to. Defaulting to
// max(1, cores - 1) leaves one core free for the server and OS themselves
// without needing a config change; override with LEGATO_MEDIA_CONCURRENCY
// when that default doesn't fit — lower on something even weaker than a
// J4125, higher on a many-core desktop where memory rather than CPU is the
// real ceiling. An invalid value (non-numeric, zero, negative) is treated
// the same as unset rather than silently wedging the queue shut.
//
// Exported as a function, same reasoning as mediaBinaries.ts's
// resolveFfmpegPath/resolveFpcalcPath: cpuCount is a parameter rather than
// a direct os.cpus() call so this is testable without mocking the OS.
export function resolveMediaConcurrencyLimit(
  env: NodeJS.ProcessEnv = process.env,
  cpuCount: number = cpus().length,
): number {
  const raw = env.LEGATO_MEDIA_CONCURRENCY;
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed >= 1) return parsed;
  }
  return Math.max(1, cpuCount - 1);
}

export const MEDIA_CONCURRENCY_LIMIT = resolveMediaConcurrencyLimit();

// The public base URL this server is reachable at, used to build the
// redirect_uri both providers send the browser back to after login (e.g.
// http://127.0.0.1:8899). Without it there's no way to construct a
// redirect_uri that will actually match what's registered with the
// provider, so it gates both providers exactly like a missing client
// id/secret does.
export const AUTH_CALLBACK_BASE_URL = process.env.AUTH_CALLBACK_BASE_URL;

// Issue #130: where to record the last time a media byte was streamed, for
// the desktop shell's keep-awake setting (stream/activity.ts). Set by the
// Tauri shell only; undefined everywhere else, which writes nothing.
export const STREAM_ACTIVITY_FILE = process.env.LEGATO_STREAM_ACTIVITY_FILE;

// Issue #114: the legato.fm service whose signed tokens this server
// accepts. It's both the `iss` a token must carry and where the public
// keys come from (<origin>/.well-known/jwks.json). Nothing contacts it
// until the owner links a legato.fm account (auth/legatoIdentity.ts).
// `off` turns legato.fm sign-in off entirely: no link, no key fetch, and
// every legato.fm token refused. Anything that isn't a plain http(s)
// origin is a startup error rather than a quiet fallback, since a typo
// here would otherwise send key fetches somewhere nobody meant.
export const DEFAULT_LEGATO_ID_ORIGIN = "https://auth.legato.fm";

export function resolveLegatoIdOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.LEGATO_ID_ORIGIN?.trim();
  if (!raw) return DEFAULT_LEGATO_ID_ORIGIN;
  if (raw.toLowerCase() === "off") return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`LEGATO_ID_ORIGIN must be an origin like ${DEFAULT_LEGATO_ID_ORIGIN}, or "off". Got "${raw}".`);
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.origin !== raw.replace(/\/$/, "")) {
    throw new Error(
      `LEGATO_ID_ORIGIN must be just an origin (scheme, host and port, no path), like ${DEFAULT_LEGATO_ID_ORIGIN}, or "off". Got "${raw}".`,
    );
  }
  return url.origin;
}

export const LEGATO_ID_ORIGIN = resolveLegatoIdOrigin();
