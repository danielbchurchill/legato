import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
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
  display_name: string | null;
  avatar_url: string | null;
  created_at: string;
  last_login_at: string;
};

export type OAuthProfile = {
  providerUserId: string;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
};

export const SESSION_COOKIE = "relay_session";

// One row per (provider, providerUserId) forever — the same account
// signing in again is an UPSERT, not a new row.
export function upsertUser(db: Database.Database, provider: Provider, profile: OAuthProfile): RelayUserRow {
  db.prepare(
    `INSERT INTO relay_users (provider, provider_user_id, email, display_name, avatar_url)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(provider, provider_user_id) DO UPDATE SET
       email = excluded.email,
       display_name = excluded.display_name,
       avatar_url = excluded.avatar_url,
       last_login_at = datetime('now')`,
  ).run(provider, profile.providerUserId, profile.email, profile.displayName, profile.avatarUrl);

  return db
    .prepare("SELECT * FROM relay_users WHERE provider = ? AND provider_user_id = ?")
    .get(provider, profile.providerUserId) as RelayUserRow;
}

// 30 days — long enough a session doesn't nag to re-auth constantly,
// short enough a token nobody explicitly revoked doesn't live forever.
// See sqlite-datetime.ts for why this is written via SQL-relative
// datetime math rather than a JS toISOString() string.
const SESSION_TTL_SQL = "+30 days";

export function createSession(db: Database.Database, userId: number): { token: string; expiresAt: Date } {
  const token = randomBytes(32).toString("hex");
  const row = db
    .prepare(
      `INSERT INTO relay_sessions (id, user_id, expires_at)
       VALUES (?, ?, datetime('now', ?))
       RETURNING expires_at`,
    )
    .get(token, userId, SESSION_TTL_SQL) as { expires_at: string };
  return { token, expiresAt: parseSqliteDatetime(row.expires_at) };
}

export function getUserBySessionToken(db: Database.Database, token: string): RelayUserRow | null {
  const row = db
    .prepare(
      `SELECT u.* FROM relay_sessions s
       JOIN relay_users u ON u.id = s.user_id
       WHERE s.id = ? AND s.expires_at > datetime('now')`,
    )
    .get(token) as RelayUserRow | undefined;
  return row ?? null;
}

export function deleteSession(db: Database.Database, token: string): void {
  db.prepare("DELETE FROM relay_sessions WHERE id = ?").run(token);
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
