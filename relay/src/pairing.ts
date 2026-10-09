import { randomBytes } from "node:crypto";
import type { Database } from "./sqlite.js";
import { generateCode, normalizeCode } from "./claimCode.js";
import { parseSqliteDatetime } from "./sqlite-datetime.js";

// The pairing-code -> tunnel-credential handoff — see migrations/
// 0002_tunnel_credentials.sql for the two-step design this implements.
//
// Issue #237 adds a third step and a second way in. The way in: a code can
// start on a headless server's /setup page instead of here, and an account
// claims it (claimServerCode). The step: redeeming a code no longer hands
// over a credential. The server proves which server it is (linked-servers.ts,
// checkClaimProof) and gets a `link` token for that account and its own id;
// the credential is minted only when the server reports that link, signed
// with its key (acceptLinkProof). A claim nobody finishes leaves no
// credential behind.

// 10 minutes: long enough to type/relay a code between two devices,
// short enough that a code nobody redeemed isn't a standing liability.
const PAIRING_CODE_TTL_SQL = "+10 minutes";

// ~1 year: this replaces what used to be a permanent, never-rotated
// RELAY_SHARED_SECRET, so it's deliberately long-lived — a home server
// pairs once and stays paired. Real rotation/revocation is a follow-up,
// not something this prototype needs yet.
const TUNNEL_CREDENTIAL_TTL_SQL = "+1 year";

export interface PairingCodeMinted {
  code: string;
  expiresAt: Date;
}

// Codes are short enough to type now (issue #113: the same K7QM-4XRD
// format a headless server shows on /setup), stored in that display form so
// a row reads the way the person saw it. 40 bits makes a clash with a live
// row unlikely rather than impossible, and the primary key would turn one
// into a 500, so a clash just draws again. Spent and expired rows are never
// deleted today, which only makes a clash fractionally likelier.
const MINT_ATTEMPTS = 5;

export function mintPairingCode(db: Database, relayUserId: number, generate = generateCode): PairingCodeMinted {
  for (let attempt = 1; ; attempt++) {
    const code = generate();
    try {
      const row = db
        .prepare(
          `INSERT INTO pairing_codes (code, relay_user_id, expires_at)
           VALUES (?, ?, datetime('now', ?))
           RETURNING expires_at`,
        )
        .get(code, relayUserId, PAIRING_CODE_TTL_SQL) as { expires_at: string };
      return { code, expiresAt: parseSqliteDatetime(row.expires_at) };
    } catch (err) {
      const clash = err instanceof Error && /UNIQUE constraint failed/.test(err.message);
      if (!clash || attempt >= MINT_ATTEMPTS) throw err;
    }
  }
}

export interface TunnelCredentialMinted {
  token: string;
  expiresAt: Date;
}

// serverId is the server the credential belongs to (migration 0006). Only
// a link report proves one, so that's the one caller that passes it.
export function mintTunnelCredential(db: Database, relayUserId: number, serverId: string | null = null): TunnelCredentialMinted {
  const token = randomBytes(32).toString("hex");
  const row = db
    .prepare(
      `INSERT INTO tunnel_credentials (token, relay_user_id, server_id, expires_at)
       VALUES (?, ?, ?, datetime('now', ?))
       RETURNING expires_at`,
    )
    .get(token, relayUserId, serverId, TUNNEL_CREDENTIAL_TTL_SQL) as { expires_at: string };
  return { token, expiresAt: parseSqliteDatetime(row.expires_at) };
}

// --- claiming a code a server made (issue #237) ---

// How many unredeemed codes one account may hold at once, claimed or
// minted. A server's code is random, so an account that claimed codes in
// advance would be guessing at 40 bits; this keeps the guesses to a handful
// every ten minutes, rather than as many as it can post.
export const OPEN_CODES_PER_ACCOUNT = 5;

export type ClaimFailure = "bad_code" | "taken" | "used" | "too_many";

export type ClaimResult = { ok: true; code: string; expiresAt: Date; already: boolean } | { ok: false; reason: ClaimFailure };

// Adopts a code a home server is showing on /setup into pairing_codes, for
// this account, the same row /pair/start would have minted. The relay can't
// know whether a server is showing the code; the server finds out by asking
// /pair/exchange for it.
//
// The code is the primary key, so a clash is decided here, never by
// overwriting:
//   - the same account again (a reload, a double tap) is the same claim;
//   - another account's live code, claimed or minted, is refused. Which of
//     the two it was doesn't matter to the person refused: someone else has
//     it, and the server's next code is theirs to scan;
//   - a spent code stays spent, so it reads "already used";
//   - an expired, unspent row is nobody's any more and is replaced.
export function claimServerCode(db: Database, relayUserId: number, typed: unknown): ClaimResult {
  const code = normalizeCode(typed);
  if (!code) return { ok: false, reason: "bad_code" };
  return db.transaction((): ClaimResult => {
    const row = db
      .prepare(
        `SELECT relay_user_id, used_at, expires_at, expires_at > datetime('now') AS live
         FROM pairing_codes WHERE code = ?`,
      )
      .get(code) as { relay_user_id: number; used_at: string | null; expires_at: string; live: number } | undefined;
    if (row?.used_at) return { ok: false, reason: "used" };
    if (row?.live) {
      if (row.relay_user_id !== relayUserId) return { ok: false, reason: "taken" };
      return { ok: true, code, expiresAt: parseSqliteDatetime(row.expires_at), already: true };
    }
    if (row) db.prepare("DELETE FROM pairing_codes WHERE code = ?").run(code);

    const { open } = db
      .prepare(
        `SELECT COUNT(*) AS open FROM pairing_codes
         WHERE relay_user_id = ? AND used_at IS NULL AND expires_at > datetime('now')`,
      )
      .get(relayUserId) as { open: number };
    if (open >= OPEN_CODES_PER_ACCOUNT) return { ok: false, reason: "too_many" };

    const inserted = db
      .prepare(
        `INSERT INTO pairing_codes (code, relay_user_id, expires_at)
         VALUES (?, ?, datetime('now', ?))
         RETURNING expires_at`,
      )
      .get(code, relayUserId, PAIRING_CODE_TTL_SQL) as { expires_at: string };
    return { ok: true, code, expiresAt: parseSqliteDatetime(inserted.expires_at), already: false };
  })();
}

// What the claim page shows for a code: this account's own claim of it
// (pending, picked up by the server, or expired unpicked), or that another
// account holds it. "taken" and "used" say no more than POST /pair/claim
// would answer for the same code.
export type ClaimStatus = "pending" | "picked_up" | "expired" | "taken" | "used" | "none";

export function claimStatus(db: Database, relayUserId: number, typed: unknown): ClaimStatus {
  const code = normalizeCode(typed);
  if (!code) return "none";
  const row = db
    .prepare(
      `SELECT relay_user_id, used_at, expires_at > datetime('now') AS live
       FROM pairing_codes WHERE code = ?`,
    )
    .get(code) as { relay_user_id: number; used_at: string | null; live: number } | undefined;
  if (!row) return "none";
  if (row.relay_user_id !== relayUserId) return row.used_at ? "used" : row.live ? "taken" : "none";
  if (row.used_at) return "picked_up";
  return row.live ? "pending" : "expired";
}

// --- redeeming a code ---

export type RedeemResult = { ok: true; relayUserId: number } | { ok: false; reason: "not_found" | "expired" | "used" };

// A transaction so two near-simultaneous redemptions of the same code
// can't both pass the used_at check — the UPDATE below only ever succeeds
// in "spending" the code once.
//
// The code arrives as someone typed it (lowercase, no dash, an O for a 0),
// so it's normalized before the lookup. Anything that can't be a code at
// all is simply not found.
export function redeemPairingCode(db: Database, typed: string): RedeemResult {
  const code = normalizeCode(typed);
  if (!code) return { ok: false, reason: "not_found" };
  return db.transaction((): RedeemResult => {
    const row = db
      .prepare(
        `SELECT relay_user_id, used_at, expires_at > datetime('now') AS not_expired
         FROM pairing_codes WHERE code = ?`,
      )
      .get(code) as { relay_user_id: number; used_at: string | null; not_expired: number } | undefined;

    if (!row) return { ok: false, reason: "not_found" };
    if (row.used_at) return { ok: false, reason: "used" };
    if (!row.not_expired) return { ok: false, reason: "expired" };

    db.prepare("UPDATE pairing_codes SET used_at = datetime('now') WHERE code = ?").run(code);
    return { ok: true, relayUserId: row.relay_user_id };
  })();
}

// Indexed lookup by primary key, not a linear scan/timing-compare — same
// discipline as accounts.ts's getUserBySessionToken. A tunnel credential
// is a high-entropy random token (32 bytes) looked up by exact match,
// the same reasoning that already makes session tokens safe to look up
// this way rather than timing-compare against every stored value.
//
// serverId is the server the credential was minted for (migration 0006),
// null for one minted before that. The tunnel (routes/tunnel.ts) refuses
// those: it's keyed by server, and no home server holds one.
export function tunnelCredentialHolder(db: Database, token: string): { relayUserId: number; serverId: string | null } | null {
  const row = db
    .prepare(`SELECT relay_user_id, server_id FROM tunnel_credentials WHERE token = ? AND expires_at > datetime('now')`)
    .get(token) as { relay_user_id: number; server_id: string | null } | undefined;
  return row ? { relayUserId: row.relay_user_id, serverId: row.server_id } : null;
}
