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

// An account as the clients that signed in to it are told about it.
export function publicUser(user: RelayUserRow) {
  return {
    id: user.id,
    provider: user.provider,
    email: user.email,
    displayName: user.display_name,
    avatarUrl: user.avatar_url,
  };
}

// 30 days — long enough a session doesn't nag to re-auth constantly,
// short enough a token nobody explicitly revoked doesn't live forever.
// See sqlite-datetime.ts for why this is written via SQL-relative
// datetime math rather than a JS toISOString() string.
const SESSION_TTL_SQL = "+30 days";

// A web session (issue #365, migration 0011) is scoped to one server and
// bound to the origin it was issued to; every other session is the whole
// account's.
export type SessionScope = { serverId: string; originMac: string };

export function createSession(db: Database, userId: number, scope?: SessionScope): { token: string; expiresAt: Date } {
  const token = randomBytes(32).toString("hex");
  const row = db
    .prepare(
      `INSERT INTO relay_sessions (id, user_id, expires_at, server_id, origin_mac)
       VALUES (?, ?, datetime('now', ?), ?, ?)
       RETURNING expires_at`,
    )
    .get(token, userId, SESSION_TTL_SQL, scope?.serverId ?? null, scope?.originMac ?? null) as { expires_at: string };
  return { token, expiresAt: parseSqliteDatetime(row.expires_at) };
}

// Null when the account is gone, so a caller holding an id from a code or
// a credential answers that rather than reading a missing row as a user.
export function getUserById(db: Database, id: number): RelayUserRow | null {
  const row = db.prepare("SELECT * FROM relay_users WHERE id = ?").get(id) as RelayUserRow | undefined;
  return row ?? null;
}

// The account a whole-account session belongs to. A web session, scoped to
// one server, is null here, so every route refuses one unless it asks for
// it by name, through getSessionByToken.
export function getUserBySessionToken(db: Database, token: string): RelayUserRow | null {
  const row = db
    .prepare(
      `SELECT u.* FROM relay_sessions s
       JOIN relay_users u ON u.id = s.user_id
       WHERE s.id = ? AND s.expires_at > datetime('now') AND s.server_id IS NULL`,
    )
    .get(token) as RelayUserRow | undefined;
  return row ?? null;
}

// Any live session, with the one server it's scoped to, or null when it's
// the whole account's. Only for the routes a web session may use: the
// relay tickets and access tokens for its server, its server in GET
// /linked-servers, and /auth/me.
export function getSessionByToken(db: Database, token: string): { user: RelayUserRow; serverId: string | null } | null {
  const row = db
    .prepare(
      `SELECT u.*, s.server_id AS session_server_id FROM relay_sessions s
       JOIN relay_users u ON u.id = s.user_id
       WHERE s.id = ? AND s.expires_at > datetime('now')`,
    )
    .get(token) as (RelayUserRow & { session_server_id: string | null }) | undefined;
  if (!row) return null;
  const { session_server_id: serverId, ...user } = row;
  return { user, serverId };
}

// True when some live web session was issued to an origin with one of
// these HMACs (one per origin key, link-codes.ts's originMacs), for
// `serverId` when it's given. What the relay's CORS asks of an origin that
// isn't the desktop app's (routes/auth.ts, routes/relay.ts).
export function hasWebSession(db: Database, originMacs: readonly string[], serverId?: string): boolean {
  if (originMacs.length === 0) return false;
  const marks = originMacs.map(() => "?").join(", ");
  const row = db
    .prepare(
      `SELECT 1 AS found FROM relay_sessions
       WHERE origin_mac IN (${marks}) AND expires_at > datetime('now')${serverId === undefined ? "" : " AND server_id = ?"}
       LIMIT 1`,
    )
    .get(...originMacs, ...(serverId === undefined ? [] : [serverId])) as { found: number } | undefined;
  return row !== undefined;
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
