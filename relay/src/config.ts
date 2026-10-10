import { homedir } from "node:os";
import path from "node:path";

// Same convention as server/src/config.ts: relay/.env.local, never
// committed, loaded here — the one module that actually reads
// process.env — because ESM import hoisting means index.ts's own
// top-level code runs *after* its `import ... from "./config.js"` has
// already evaluated. Missing file is the expected case until Daniel
// creates one; every var below already treats undefined as "feature
// quietly inactive," not an error.
try {
  process.loadEnvFile(path.join(import.meta.dirname, "..", ".env.local"));
} catch {
  // No .env.local yet.
}

export const PORT = Number(process.env.RELAY_PORT ?? 8901);

// Fly sets FLY_APP_NAME on every machine it runs. Only there does its proxy
// stand in front of this service and write Fly-Client-IP (rate-limit.ts).
export const ON_FLY = Boolean(process.env.FLY_APP_NAME);

// Only matters when running this service outside whatever container/host
// sets its own persistent volume path — real deployment default
// resolution is that host's job, the same platform split as server/'s
// LEGATO_DATA_DIR.
export const DATA_DIR = path.resolve(
  process.env.RELAY_DATA_DIR ?? path.join(homedir(), ".local", "share", "legato-relay"),
);

// Relay account OAuth — deliberately its own env vars, separate from
// server/'s GOOGLE_CLIENT_ID etc (server/src/config.ts), even though the
// provider glue (routes/auth.ts) is near-identical: this is a genuinely
// separate OAuth app registration (different callback URL, different
// consent screen) for a genuinely separate identity system. See
// routes/auth.ts's header comment for what relay_users answers that
// server/'s users table doesn't. Same graceful-absence contract as
// server/'s version: undefined here just leaves that provider's two
// routes quietly 503ing (isGoogleConfigured/isGithubConfigured in
// routes/auth.ts), never a crash.
export const RELAY_GOOGLE_CLIENT_ID = process.env.RELAY_GOOGLE_CLIENT_ID;
export const RELAY_GOOGLE_CLIENT_SECRET = process.env.RELAY_GOOGLE_CLIENT_SECRET;
export const RELAY_GITHUB_CLIENT_ID = process.env.RELAY_GITHUB_CLIENT_ID;
export const RELAY_GITHUB_CLIENT_SECRET = process.env.RELAY_GITHUB_CLIENT_SECRET;

// The public base URL this relay is reachable at — builds the
// redirect_uri both providers send the browser back to after login.
// Gates both providers exactly like a missing client id/secret does:
// without it there's no way to construct a redirect_uri that matches
// what's registered with the provider.
export const RELAY_AUTH_CALLBACK_BASE_URL = process.env.RELAY_AUTH_CALLBACK_BASE_URL;

// Issue #114: the Ed25519 keys legato.fm signs home-server tokens with.
// A JSON array of { privateKey: PEM }; see signing-keys.ts for the format
// and the rotation steps, and scripts/generate-signing-key.ts to make one.
// Unset is a working relay with token signing off: the JWKS is empty and
// POST /auth/server-token 503s, the same graceful absence as an
// unconfigured OAuth provider.
export const RELAY_SIGNING_KEYS = process.env.RELAY_SIGNING_KEYS;
