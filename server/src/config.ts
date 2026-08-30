import { homedir } from "node:os";
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

// The public base URL this server is reachable at, used to build the
// redirect_uri both providers send the browser back to after login (e.g.
// http://127.0.0.1:8899). Without it there's no way to construct a
// redirect_uri that will actually match what's registered with the
// provider, so it gates both providers exactly like a missing client
// id/secret does.
export const AUTH_CALLBACK_BASE_URL = process.env.AUTH_CALLBACK_BASE_URL;
