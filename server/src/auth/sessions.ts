import { createHash, randomBytes } from "node:crypto";
import type { Database } from "../sqlite.js";

// Session storage for the gate (issue #112, migration 0029). A session is
// two random tokens: the session token proper, which authorizes anything,
// and a media ticket, which gate.ts only accepts on GET/HEAD and the
// WebSocket upgrade. Only their SHA-256 digests are stored — a plain hash
// rather than a slow KDF is right here, because the input is 32 random
// bytes, not something a person chose, so there is nothing to brute-force.

export type Role = "owner" | "legacy";

export type SessionUser = {
  id: number;
  provider: "local" | "google" | "github";
  role: Role;
  email: string | null;
  display_name: string | null;
  avatar_url: string | null;
};

export type IssuedSession = {
  token: string;
  mediaTicket: string;
  expiresAt: Date;
};

// 30 days, sliding. Long enough that a device used every week or so never
// sees a sign-in screen; a device nobody touches for a month has to prove
// itself again.
export const SESSION_TTL_DAYS = 30;

// Sliding expiry writes to the database, so it's rate-limited to once a
// day per session. Otherwise every cover thumbnail on a 5,000-node canvas
// would be an UPDATE.
const REFRESH_EVERY = "-1 day";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function createSession(db: Database, userId: number): IssuedSession {
  const token = newToken();
  const mediaTicket = newToken();
  db.prepare(
    `INSERT INTO sessions (token_hash, media_ticket_hash, user_id, expires_at)
     VALUES (?, ?, ?, datetime('now', ?))`,
  ).run(hashToken(token), hashToken(mediaTicket), userId, `+${SESSION_TTL_DAYS} days`);
  const { expires_at } = db
    .prepare("SELECT expires_at FROM sessions WHERE token_hash = ?")
    .get(hashToken(token)) as { expires_at: string };
  return { token, mediaTicket, expiresAt: sqliteTimeToDate(expires_at) };
}

// SQLite's datetime() is UTC with a space instead of the ISO 'T' and no
// zone suffix. Stored that way on purpose so `expires_at > datetime('now')`
// compares like with like.
function sqliteTimeToDate(value: string): Date {
  return new Date(`${value.replace(" ", "T")}Z`);
}

type Column = "token_hash" | "media_ticket_hash";

function lookup(db: Database, column: Column, credential: string): { user: SessionUser; tokenHash: string } | null {
  if (!credential) return null;
  const row = db
    .prepare(
      `SELECT s.token_hash, u.id, u.provider, u.role, u.email, u.display_name, u.avatar_url
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.${column} = ? AND s.expires_at > datetime('now')`,
    )
    .get(hashToken(credential)) as (SessionUser & { token_hash: string }) | undefined;
  if (!row) return null;

  db.prepare(
    `UPDATE sessions SET expires_at = datetime('now', ?), refreshed_at = datetime('now')
     WHERE token_hash = ? AND refreshed_at < datetime('now', ?)`,
  ).run(`+${SESSION_TTL_DAYS} days`, row.token_hash, REFRESH_EVERY);

  const { token_hash, ...user } = row;
  return { user, tokenHash: token_hash };
}

export function userForSessionToken(db: Database, token: string): SessionUser | null {
  return lookup(db, "token_hash", token)?.user ?? null;
}

export function userForMediaTicket(db: Database, ticket: string): SessionUser | null {
  return lookup(db, "media_ticket_hash", ticket)?.user ?? null;
}

export function deleteSession(db: Database, token: string): void {
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
}
