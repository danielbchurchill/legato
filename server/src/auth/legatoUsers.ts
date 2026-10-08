import type { Database } from "../sqlite.js";
import type { LegatoClaims } from "./legatoToken.js";
import { deleteLegatoSessions, type SessionUser } from "./sessions.js";

// Mapping a verified legato.fm token onto this server's users (issue #114,
// migration 0032). Nothing here creates a row. A legato.fm account this
// server doesn't know is refused, because "anyone with a legato.fm account
// gets a row" would mean anyone with one gets the library. Inviting
// another account in is #143.

const USER_COLUMNS = "id, provider, role, email, display_name, avatar_url";

export function anyLinkedAccount(db: Database): boolean {
  return db.prepare("SELECT 1 FROM users WHERE legato_account_id IS NOT NULL LIMIT 1").get() !== undefined;
}

export function linkedAccountId(db: Database, userId: number): string | null {
  const row = db.prepare("SELECT legato_account_id FROM users WHERE id = ?").get(userId) as
    | { legato_account_id: string | null }
    | undefined;
  return row?.legato_account_id ?? null;
}

// Issue #114's migration step for Google/GitHub users from before 0029,
// run the first time their account shows up rather than in 0032 itself:
// the legato.fm accounts aren't on this machine, so the SQL migration has
// nothing to match against. Links only when legato.fm says the email is
// verified and exactly one unlinked legacy row has it. Two rows with the
// same address is a question for the owner, not something to guess at.
// The local owner never matches by email; it's linked on purpose, through
// linkAccount.
function linkByVerifiedEmail(db: Database, claims: LegatoClaims): number | null {
  if (!claims.emailVerified || !claims.email) return null;
  const candidates = db
    .prepare(
      `SELECT id FROM users
       WHERE provider IN ('google', 'github') AND role = 'legacy'
         AND legato_account_id IS NULL
         AND email IS NOT NULL AND lower(trim(email)) = lower(trim(?))`,
    )
    .all(claims.email) as { id: number }[];
  if (candidates.length !== 1) return null;
  const id = candidates[0]!.id;
  db.prepare("UPDATE users SET legato_account_id = ? WHERE id = ? AND legato_account_id IS NULL").run(claims.sub, id);
  return id;
}

export function userForLegatoClaims(db: Database, claims: LegatoClaims): SessionUser | null {
  const linked = db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE legato_account_id = ?`).get(claims.sub) as
    | SessionUser
    | undefined;
  if (linked) return linked;
  const matched = linkByVerifiedEmail(db, claims);
  if (matched === null) return null;
  return db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(matched) as SessionUser;
}

// Whether linking would clash with another row, asked before the link
// route tells legato.fm, so a link that can't happen here never gets
// recorded there. linkAccount still has the final say, through the index.
export function accountLinkedToOtherUser(db: Database, accountId: string, userId: number): boolean {
  return db.prepare("SELECT 1 FROM users WHERE legato_account_id = ? AND id != ?").get(accountId, userId) !== undefined;
}

export type LinkResult = { ok: true } | { ok: false; reason: "taken" };

// The unique index users_legato_account_id (0032) is what actually decides
// a clash, so this can't race into one account owning two rows.
//
// Sessions the previous account's tokens opened end here (issue #117): that
// account no longer opens this row.
export function linkAccount(db: Database, userId: number, accountId: string): LinkResult {
  const previous = linkedAccountId(db, userId);
  try {
    db.prepare("UPDATE users SET legato_account_id = ? WHERE id = ?").run(accountId, userId);
    if (previous && previous !== accountId) deleteLegatoSessions(db, previous);
    return { ok: true };
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed/.test(err.message)) return { ok: false, reason: "taken" };
    throw err;
  }
}

export function unlinkAccount(db: Database, userId: number): void {
  const accountId = linkedAccountId(db, userId);
  db.prepare("UPDATE users SET legato_account_id = NULL WHERE id = ?").run(userId);
  if (accountId) deleteLegatoSessions(db, accountId);
}
