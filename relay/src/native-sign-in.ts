import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Provider } from "./accounts.js";
import type { Database } from "./sqlite.js";

// The relay half of handing a browser sign-in back to the desktop app
// (issue #215): OAuth for native apps (RFC 8252) with PKCE (RFC 7636).
// See migrations/0003_native_sign_in.sql for the two tables and why they
// hold only hashes.

// The one path the desktop app's loopback listener serves
// (src-tauri/src/relay_sign_in.rs). Fixed so a redirect_uri can't point a
// code at anything else on 127.0.0.1 that happens to answer HTTP.
export const NATIVE_CALLBACK_PATH = "/callback";

// Matches the relay_oauth_state cookie's maxAge: a pending request can't
// outlive the cookie that has to come back with it anyway.
const NATIVE_REQUEST_TTL_SQL = "+10 minutes";

// RFC 8252 asks for a short lifetime; 60 seconds is ample, because the
// browser follows the loopback redirect and the app redeems at once.
const AUTH_CODE_TTL_SQL = "+60 seconds";

// Spent and expired codes are kept for an hour before they're swept, so
// a reuse still reads "already used" instead of "unknown" in that window.
const AUTH_CODE_SWEEP_SQL = "-1 hour";

// A base64url SHA-256 digest is always exactly 43 characters.
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
// RFC 7636 §4.1: 43 to 128 characters from the unreserved set.
const VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function s256Challenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

// Only a loopback IP literal, never `localhost`: RFC 8252 §8.3, since a
// name can resolve somewhere other than this machine. The canonical form
// is compared exactly, so `127.000.000.001`, `:080`, a trailing `?`, a
// userinfo or a fragment all fail rather than being normalized into a
// pass. An explicit, nonzero port is required: the app always binds an
// ephemeral one, and a bare `http://127.0.0.1/callback` would mean port 80.
export function isLoopbackRedirect(redirectUri: string): boolean {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  if (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") return false;
  if (!url.port || url.port === "0") return false;
  if (url.pathname !== NATIVE_CALLBACK_PATH) return false;
  return redirectUri === `http://${url.host}${NATIVE_CALLBACK_PATH}`;
}

export type NativeParams = { codeChallenge: string; redirectUri: string };

export type NativeQuery = {
  redirect_uri?: string;
  code_challenge?: string;
  code_challenge_method?: string;
};

export type ParsedStart = { kind: "browser" } | { kind: "native"; params: NativeParams } | { kind: "invalid"; message: string };

// No native parameter at all is today's browser sign-in, untouched. Any
// one of them makes it a native request, which then needs all three: a
// half-formed request falling back to the cookie flow would leave the app
// waiting on a listener that's never called.
export function parseNativeStart(query: NativeQuery): ParsedStart {
  const { redirect_uri, code_challenge, code_challenge_method } = query;
  if (redirect_uri === undefined && code_challenge === undefined && code_challenge_method === undefined) {
    return { kind: "browser" };
  }
  if (code_challenge_method !== "S256") {
    return { kind: "invalid", message: "code_challenge_method must be S256. Plain PKCE isn't accepted." };
  }
  if (!code_challenge || !CHALLENGE_PATTERN.test(code_challenge)) {
    return {
      kind: "invalid",
      message: "code_challenge must be the base64url SHA-256 of the code verifier (43 characters).",
    };
  }
  if (!redirect_uri || !isLoopbackRedirect(redirect_uri)) {
    return {
      kind: "invalid",
      message: `Sign-in can only return to this computer: redirect_uri must be http://127.0.0.1:<port>${NATIVE_CALLBACK_PATH} or http://[::1]:<port>${NATIVE_CALLBACK_PATH}.`,
    };
  }
  return { kind: "native", params: { codeChallenge: code_challenge, redirectUri: redirect_uri } };
}

export function createNativeRequest(db: Database, state: string, provider: Provider, params: NativeParams): void {
  db.prepare("DELETE FROM relay_native_requests WHERE expires_at <= datetime('now')").run();
  db.prepare(
    `INSERT INTO relay_native_requests (state_hash, provider, code_challenge, redirect_uri, expires_at)
     VALUES (?, ?, ?, ?, datetime('now', ?))`,
  ).run(sha256Hex(state), provider, params.codeChallenge, params.redirectUri, NATIVE_REQUEST_TTL_SQL);
}

// Deletes as it reads, so a replayed callback with the same state finds
// nothing. An expired row is deleted too, but returned as null.
export function takeNativeRequest(db: Database, state: string, provider: Provider): NativeParams | null {
  const row = db
    .prepare(
      `DELETE FROM relay_native_requests
       WHERE state_hash = ? AND provider = ?
       RETURNING code_challenge, redirect_uri, expires_at > datetime('now') AS live`,
    )
    .get(sha256Hex(state), provider) as { code_challenge: string; redirect_uri: string; live: number } | undefined;
  if (!row || !row.live) return null;
  return { codeChallenge: row.code_challenge, redirectUri: row.redirect_uri };
}

export function mintAuthCode(db: Database, relayUserId: number, params: NativeParams): string {
  db.prepare("DELETE FROM relay_auth_codes WHERE expires_at <= datetime('now', ?)").run(AUTH_CODE_SWEEP_SQL);
  const code = randomBytes(32).toString("base64url");
  db.prepare(
    `INSERT INTO relay_auth_codes (code_hash, relay_user_id, code_challenge, redirect_uri, expires_at)
     VALUES (?, ?, ?, ?, datetime('now', ?))`,
  ).run(sha256Hex(code), relayUserId, params.codeChallenge, params.redirectUri, AUTH_CODE_TTL_SQL);
  return code;
}

export type RedeemFailure = "malformed" | "not_found" | "used" | "expired" | "mismatch";
export type RedeemResult = { ok: true; relayUserId: number } | { ok: false; reason: RedeemFailure };

export const REDEEM_FAILURE_MESSAGES: Record<RedeemFailure, string> = {
  malformed: "code, code_verifier (43 to 128 characters) and redirect_uri are all required.",
  not_found: "legato.fm doesn't recognise this sign-in code. Start sign-in again from Legato.",
  used: "This sign-in code was already used. Start sign-in again from Legato.",
  expired: "This sign-in code expired. Codes last 60 seconds; start sign-in again from Legato.",
  mismatch: "This sign-in code was issued to a different request. Start sign-in again from Legato.",
};

export type RedeemInput = { code?: unknown; codeVerifier?: unknown; redirectUri?: unknown };

// The code is spent on the first attempt that finds it, before the
// verifier is checked (RFC 6749 §4.1.2): a wrong guess burns it rather
// than leaving it open for a second try. One transaction, the same
// discipline as pairing.ts's redeemPairingCode, so two racing
// redemptions can't both get past the used_at check.
export function redeemAuthCode(db: Database, input: RedeemInput): RedeemResult {
  const { code, codeVerifier, redirectUri } = input;
  if (
    typeof code !== "string" ||
    !code ||
    typeof codeVerifier !== "string" ||
    !VERIFIER_PATTERN.test(codeVerifier) ||
    typeof redirectUri !== "string"
  ) {
    return { ok: false, reason: "malformed" };
  }

  return db.transaction((): RedeemResult => {
    const codeHash = sha256Hex(code);
    const row = db
      .prepare(
        `SELECT relay_user_id, code_challenge, redirect_uri, used_at,
                expires_at > datetime('now') AS live
         FROM relay_auth_codes WHERE code_hash = ?`,
      )
      .get(codeHash) as
      | { relay_user_id: number; code_challenge: string; redirect_uri: string; used_at: string | null; live: number }
      | undefined;

    if (!row) return { ok: false, reason: "not_found" };
    if (row.used_at) return { ok: false, reason: "used" };
    db.prepare("UPDATE relay_auth_codes SET used_at = datetime('now') WHERE code_hash = ?").run(codeHash);
    if (!row.live) return { ok: false, reason: "expired" };

    // Exact string match, scheme, host, port and path, not "any loopback":
    // the code is bound to the one listener it was sent to.
    if (redirectUri !== row.redirect_uri) return { ok: false, reason: "mismatch" };
    const expected = Buffer.from(row.code_challenge);
    const actual = Buffer.from(s256Challenge(codeVerifier));
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      return { ok: false, reason: "mismatch" };
    }
    return { ok: true, relayUserId: row.relay_user_id };
  })();
}
