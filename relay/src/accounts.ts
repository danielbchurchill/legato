import { randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { Database } from "./sqlite.js";
import { parseSqliteDatetime } from "./sqlite-datetime.js";

// Relay-side account and session storage — see migrations/
// 0001_relay_users.sql for why this is a separate identity system from
// server/'s own users/sessions tables, and server/src/routes/auth.ts for
// the pattern these functions deliberately mirror.

export type Provider = "google" | "github";

export type RelayUserRow = {
  id: number;
  provider: Provider;
  provider_user_id: string;
  email: string | null;
  email_verified: 0 | 1;
  display_name: string | null;
  avatar_url: string | null;
  created_at: string;
  last_login_at: string;
};

export type OAuthProfile = {
  providerUserId: string;
  email: string | null;
  // Whether the provider vouched for `email` (migration 0004). Optional so
  // that leaving it out reads as "not known", which is false.
  emailVerified?: boolean;
  displayName: string | null;
  avatarUrl: string | null;
};

export const SESSION_COOKIE = "relay_session";

// One row per (provider, providerUserId) forever — the same account
// signing in again is an UPSERT, not a new row.
export function upsertUser(db: Database, provider: Provider, profile: OAuthProfile): RelayUserRow {
  db.prepare(
    `INSERT INTO relay_users (provider, provider_user_id, email, email_verified, display_name, avatar_url)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider, provider_user_id) DO UPDATE SET
       email = excluded.email,
       email_verified = excluded.email_verified,
       display_name = excluded.display_name,
       avatar_url = excluded.avatar_url,
       last_login_at = datetime('now')`,
  ).run(
    provider,
    profile.providerUserId,
    profile.email,
    profile.email !== null && profile.emailVerified === true ? 1 : 0,
    profile.displayName,
    profile.avatarUrl,
  );

  return db
    .prepare("SELECT * FROM relay_users WHERE provider = ? AND provider_user_id = ?")
    .get(provider, profile.providerUserId) as RelayUserRow;
}

// 30 days — long enough a session doesn't nag to re-auth constantly,
// short enough a token nobody explicitly revoked doesn't live forever.
// See sqlite-datetime.ts for why this is written via SQL-relative
// datetime math rather than a JS toISOString() string.
const SESSION_TTL_SQL = "+30 days";

// client is describeClient()'s label for what signed in (issue #115).
export function createSession(db: Database, userId: number, client: string | null = null): { token: string; expiresAt: Date } {
  const token = randomBytes(32).toString("hex");
  const row = db
    .prepare(
      `INSERT INTO relay_sessions (id, user_id, client, expires_at)
       VALUES (?, ?, ?, datetime('now', ?))
       RETURNING expires_at`,
    )
    .get(token, userId, client, SESSION_TTL_SQL) as { expires_at: string };
  return { token, expiresAt: parseSqliteDatetime(row.expires_at) };
}

// What an account's settings call a session (issue #115): the app or the
// browser, and the system it runs on, read once from the User-Agent at
// sign-in. Only this label is stored. "app" is the desktop app's own
// sign-in (POST /auth/token), whose User-Agent is its webview's.
export function describeClient(userAgent: string | undefined, kind: "app" | "browser"): string {
  const ua = userAgent ?? "";
  const system = /iPhone|iPad|iPod/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /CrOS/.test(ua)
        ? "ChromeOS"
        : /Macintosh|Mac OS X/.test(ua)
          ? "macOS"
          : /Windows/.test(ua)
            ? "Windows"
            : /Linux|X11/.test(ua)
              ? "Linux"
              : null;
  const what =
    kind === "app"
      ? "Legato app"
      : /Edg\//.test(ua)
        ? "Edge"
        : /Firefox\/|FxiOS/.test(ua)
          ? "Firefox"
          : /Chrome\/|CriOS/.test(ua)
            ? "Chrome"
            : /Safari\//.test(ua)
              ? "Safari"
              : "A browser";
  return system ? `${what} on ${system}` : what;
}

export type SessionListing = { id: string; client: string | null; createdAt: Date; lastSeenAt: Date | null; current: boolean };

// The account's live sessions, newest first, for its settings (issue #115).
// A session's id here is its rowid, never its token: the token is what
// signs it in. current marks the one asking.
export function listSessions(db: Database, userId: number, currentToken: string): SessionListing[] {
  const rows = db
    .prepare(
      `SELECT rowid, id, client, created_at, last_seen_at FROM relay_sessions
       WHERE user_id = ? AND expires_at > datetime('now') ORDER BY created_at DESC, rowid DESC`,
    )
    .all(userId) as { rowid: number; id: string; client: string | null; created_at: string; last_seen_at: string | null }[];
  return rows.map((row) => ({
    id: String(row.rowid),
    client: row.client,
    createdAt: parseSqliteDatetime(row.created_at),
    lastSeenAt: row.last_seen_at ? parseSqliteDatetime(row.last_seen_at) : null,
    current: row.id === currentToken,
  }));
}

// Signs one of the account's own sessions out. False for an id that isn't
// one of them.
export function revokeSession(db: Database, userId: number, id: string): boolean {
  if (!/^[1-9][0-9]{0,15}$/.test(id)) return false;
  return db.prepare("DELETE FROM relay_sessions WHERE rowid = ? AND user_id = ?").run(Number(id), userId).changes > 0;
}

// Null when the account is gone, so a caller holding an id from a code or
// a credential answers that rather than reading a missing row as a user.
export function getUserById(db: Database, id: number): RelayUserRow | null {
  const row = db.prepare("SELECT * FROM relay_users WHERE id = ?").get(id) as RelayUserRow | undefined;
  return row ?? null;
}

// How stale a session's last_seen_at may get before a request writes it
// again (issue #115): "last seen" to the nearest few minutes, without a
// write on every request.
const LAST_SEEN_EVERY_SQL = "-5 minutes";

export function getUserBySessionToken(db: Database, token: string): RelayUserRow | null {
  const row = db
    .prepare(
      `SELECT u.*, s.last_seen_at IS NULL OR s.last_seen_at < datetime('now', ?) AS session_stale
       FROM relay_sessions s
       JOIN relay_users u ON u.id = s.user_id
       WHERE s.id = ? AND s.expires_at > datetime('now')`,
    )
    .get(LAST_SEEN_EVERY_SQL, token) as (RelayUserRow & { session_stale: number }) | undefined;
  if (!row) return null;
  const { session_stale, ...user } = row;
  if (session_stale) db.prepare("UPDATE relay_sessions SET last_seen_at = datetime('now') WHERE id = ?").run(token);
  return user;
}

export function deleteSession(db: Database, token: string): void {
  db.prepare("DELETE FROM relay_sessions WHERE id = ?").run(token);
}

// A bearer token wins over the cookie: the desktop app only ever sends
// the header, and a browser only ever has the cookie, so in practice a
// request carries one or the other.
export function sessionToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length).trim() || undefined;
  return request.cookies[SESSION_COOKIE];
}

// --- CSRF state ---

export function generateState(): string {
  return randomBytes(16).toString("hex");
}

// Split out from the callback route so the check itself is unit-testable
// without a live OAuth round trip.
export function isValidState(cookieState: string | undefined, queryState: string | undefined): boolean {
  return Boolean(cookieState) && cookieState === queryState;
}
