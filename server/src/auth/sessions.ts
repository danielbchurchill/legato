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

// A session made from a legato.fm access token (issue #117, migration 0040)
// lasts this long and never slides. legato.fm stops signing access tokens
// as soon as an account revokes or unlinks, and a session must not outlive
// that by much: twelve hours bounds it to half a day. The client renews well
// before the end, through legato.fm, so a day of listening never sees a
// sign-in screen, and keeps working through hours of the internet being
// down at home (src/connect/legatoSignIn.ts).
export const LEGATO_SESSION_TTL_HOURS = 12;

export function createSession(db: Database, userId: number, legatoAccountId: string | null = null): IssuedSession {
  const token = newToken();
  const mediaTicket = newToken();
  const lifetime = legatoAccountId === null ? `+${SESSION_TTL_DAYS} days` : `+${LEGATO_SESSION_TTL_HOURS} hours`;
  db.prepare(
    `INSERT INTO sessions (token_hash, media_ticket_hash, user_id, expires_at, legato_account_id)
     VALUES (?, ?, ?, datetime('now', ?), ?)`,
  ).run(hashToken(token), hashToken(mediaTicket), userId, lifetime, legatoAccountId);
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

  // A legato.fm session keeps the expiry it was issued with (below).
  db.prepare(
    `UPDATE sessions SET expires_at = datetime('now', ?), refreshed_at = datetime('now')
     WHERE token_hash = ? AND refreshed_at < datetime('now', ?) AND legato_account_id IS NULL`,
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

// Unlinking a legato.fm account here, or linking another in its place, ends
// every session that account's tokens opened (auth/legatoUsers.ts).
export function deleteLegatoSessions(db: Database, legatoAccountId: string): void {
  db.prepare("DELETE FROM sessions WHERE legato_account_id = ?").run(legatoAccountId);
}

// False when this access token was already exchanged for a session. Rows
// whose token has expired go first: the gate refuses that token by now, so
// the row has nothing left to guard.
export function spendAccessToken(db: Database, jti: string, expiresAtSeconds: number): boolean {
  db.prepare("DELETE FROM spent_access_tokens WHERE expires_at < datetime('now')").run();
  return (
    db
      .prepare("INSERT OR IGNORE INTO spent_access_tokens (jti, expires_at) VALUES (?, datetime(?, 'unixepoch'))")
      .run(jti, expiresAtSeconds).changes > 0
  );
}
