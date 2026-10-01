import { randomBytes } from "node:crypto";
import type { Database } from "./sqlite.js";
import { generateCode, normalizeCode } from "./claimCode.js";
import { parseSqliteDatetime } from "./sqlite-datetime.js";

// The pairing-code -> tunnel-credential handoff — see migrations/
// 0002_tunnel_credentials.sql for the two-step design this implements.

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

export function mintTunnelCredential(db: Database, relayUserId: number): TunnelCredentialMinted {
  const token = randomBytes(32).toString("hex");
  const row = db
    .prepare(
      `INSERT INTO tunnel_credentials (token, relay_user_id, expires_at)
       VALUES (?, ?, datetime('now', ?))
       RETURNING expires_at`,
    )
    .get(token, relayUserId, TUNNEL_CREDENTIAL_TTL_SQL) as { expires_at: string };
  return { token, expiresAt: parseSqliteDatetime(row.expires_at) };
}

export type RedeemResult =
  | { ok: true; credential: string; expiresAt: Date }
  | { ok: false; reason: "not_found" | "expired" | "used" };

// A transaction so two near-simultaneous redemptions of the same code
// can't both pass the used_at check and each mint their own credential —
// the UPDATE below only ever succeeds in "spending" the code once.
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
    const credential = mintTunnelCredential(db, row.relay_user_id);
    return { ok: true, credential: credential.token, expiresAt: credential.expiresAt };
  })();
}

// Indexed lookup by primary key, not a linear scan/timing-compare — same
// discipline as accounts.ts's getUserBySessionToken. A tunnel credential
// is a high-entropy random token (32 bytes) looked up by exact match,
// the same reasoning that already makes session tokens safe to look up
// this way rather than timing-compare against every stored value.
export function getRelayUserIdByCredential(db: Database, token: string): number | null {
  const row = db
    .prepare(`SELECT relay_user_id FROM tunnel_credentials WHERE token = ? AND expires_at > datetime('now')`)
    .get(token) as { relay_user_id: number } | undefined;
  return row?.relay_user_id ?? null;
}
