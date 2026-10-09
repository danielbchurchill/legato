import { randomBytes } from "node:crypto";
import type { Database } from "./sqlite.js";
import { normalizeCode } from "./claimCode.js";
import { SERVER_ID_PATTERN } from "./signing-keys.js";
import { parseSqliteDatetime } from "./sqlite-datetime.js";

// Pairing codes: how a headless home server, which has no relay session,
// gets linked to the legato.fm account someone signed in with.
//
// Every code starts on a server's /setup page (issue #237). An account
// claims it on the claim page (claimServerCode), for the server whose QR it
// scanned. That server proves which server it is (linked-servers.ts,
// claimProofSigned) and redeems the code for a `link` token for that account
// and its own id. The tunnel credential is minted only when the server
// reports that link, signed with its key (acceptLinkProof), so a claim
// nobody finishes leaves no credential behind.
//
// Issue #324 binds a claim to one server. A code is 40 bits and a claim
// proof costs nothing to make, so without that, anyone who guessed a code
// someone had just claimed could redeem it with a key of their own. The
// QR on /setup carries the server's id with the code, the claim stores it
// (migration 0009), and redeeming answers any other server exactly as it
// would a code nobody claimed.
//
// Until #353 an account could also mint a code here (POST /pair/start), the
// first step of the design in migrations/0002_tunnel_credentials.sql.
// Nothing called it, and since #324 nothing could redeem what it minted.
// The rows it left, like claims made before 0009, have no server_id: no
// server can redeem them, and they expire within ten minutes like any other.

// 10 minutes: long enough to type/relay a code between two devices,
// short enough that a code nobody redeemed isn't a standing liability.
const PAIRING_CODE_TTL_SQL = "+10 minutes";

// ~1 year: this replaces what used to be a permanent, never-rotated
// RELAY_SHARED_SECRET, so it's deliberately long-lived — a home server
// pairs once and stays paired. Real rotation/revocation is a follow-up,
// not something this prototype needs yet.
const TUNNEL_CREDENTIAL_TTL_SQL = "+1 year";

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

// How many unredeemed codes one account may hold at once. A server's code
// is random, so an account that claimed codes in advance would be guessing
// at 40 bits; this keeps the guesses to a handful every ten minutes, rather
// than as many as it can post.
export const OPEN_CODES_PER_ACCOUNT = 5;

export type ClaimFailure = "bad_code" | "outdated_server" | "taken" | "used" | "too_many";

export type ClaimResult = { ok: true; code: string; expiresAt: Date; already: boolean } | { ok: false; reason: ClaimFailure };

// Adopts a code a home server is showing on /setup into pairing_codes, for
// this account and the server the QR named. The relay can't know whether
// that server is showing the code; the server finds out by asking
// /pair/exchange for it. A QR with no server id is from a server that
// predates #324, and nothing could redeem a claim of it. One with an id
// that can't be one is a broken link, like a code that can't be one, and
// GET /claim calls both the same (routes/claim-page.ts).
//
// The code is the primary key, so a clash is decided here, never by
// overwriting:
//   - the same account again (a reload, a double tap) is the same claim,
//     for whichever server it names last;
//   - another account's live code is refused: someone else has it, and
//     the server's next code is theirs to scan;
//   - a spent code stays spent, so it reads "already used";
//   - an expired, unspent row is nobody's any more and is replaced.
export function claimServerCode(db: Database, relayUserId: number, typed: unknown, serverId: unknown): ClaimResult {
  const code = normalizeCode(typed);
  if (!code) return { ok: false, reason: "bad_code" };
  if (serverId === undefined || serverId === null || serverId === "") return { ok: false, reason: "outdated_server" };
  if (typeof serverId !== "string" || !SERVER_ID_PATTERN.test(serverId)) return { ok: false, reason: "bad_code" };
  return db.transaction((): ClaimResult => {
    const row = db
      .prepare(
        `SELECT relay_user_id, server_id, used_at, expires_at, expires_at > datetime('now') AS live
         FROM pairing_codes WHERE code = ?`,
      )
      .get(code) as
      | { relay_user_id: number; server_id: string | null; used_at: string | null; expires_at: string; live: number }
      | undefined;
    if (row?.used_at) return { ok: false, reason: "used" };
    if (row?.live) {
      if (row.relay_user_id !== relayUserId) return { ok: false, reason: "taken" };
      if (row.server_id !== serverId) db.prepare("UPDATE pairing_codes SET server_id = ? WHERE code = ?").run(serverId, code);
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
        `INSERT INTO pairing_codes (code, relay_user_id, server_id, expires_at)
         VALUES (?, ?, ?, datetime('now', ?))
         RETURNING expires_at`,
      )
      .get(code, relayUserId, serverId, PAIRING_CODE_TTL_SQL) as { expires_at: string };
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

// Whether this code is claimed for this server, in any state: one primary
// key lookup, before anything else about the ask is checked (routes/pair.ts).
export function isClaimedFor(db: Database, code: string, serverId: string): boolean {
  return db.prepare("SELECT 1 FROM pairing_codes WHERE code = ? AND server_id = ?").get(code, serverId) !== undefined;
}

export type RedeemResult =
  | { ok: true; relayUserId: number; linkToken: string; again: boolean }
  | { ok: false; reason: "not_found" | "expired" | "used" };

// A transaction so two near-simultaneous redemptions of the same code
// can't both pass the used_at check — the UPDATE below only ever succeeds
// in "spending" the code once. issue signs the link token for the account
// that claimed it, once per code, inside that transaction, and the token is
// kept with the code.
//
// The code arrives as someone typed it (lowercase, no dash, an O for a 0),
// so it's normalized before the lookup. Anything that can't be a code at
// all is simply not found.
//
// serverId is the server redeeming, from its signed proof. A code claimed
// for any other server, or for none (a row from before #324), is not found
// either: whether it's used, expired or live is that server's business, so
// the answer says nothing about it, and the code stays unspent.
//
// The server it's claimed for gets the same answer again while the claim
// lasts (again: true): the token it was handed, so the answer it never got
// is never lost (issue #324). With the claim bound to it, nothing else can
// have spent the code, so "used" only ever means this server's own
// redemption, after the claim ran out.
export function redeemPairingCode(db: Database, typed: string, serverId: string, issue: (relayUserId: number) => string): RedeemResult {
  const code = normalizeCode(typed);
  if (!code) return { ok: false, reason: "not_found" };
  return db.transaction((): RedeemResult => {
    const row = db
      .prepare(
        `SELECT relay_user_id, server_id, used_at, link_token, expires_at > datetime('now') AS not_expired
         FROM pairing_codes WHERE code = ?`,
      )
      .get(code) as
      | { relay_user_id: number; server_id: string | null; used_at: string | null; link_token: string | null; not_expired: number }
      | undefined;

    if (!row || row.server_id !== serverId) return { ok: false, reason: "not_found" };
    if (row.used_at) {
      if (row.not_expired && row.link_token) return { ok: true, relayUserId: row.relay_user_id, linkToken: row.link_token, again: true };
      return { ok: false, reason: "used" };
    }
    if (!row.not_expired) return { ok: false, reason: "expired" };

    const linkToken = issue(row.relay_user_id);
    db.prepare("UPDATE pairing_codes SET used_at = datetime('now'), link_token = ? WHERE code = ?").run(linkToken, code);
    return { ok: true, relayUserId: row.relay_user_id, linkToken, again: false };
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

// A tunnel signing in with a credential (routes/tunnel.ts). The first time
// a credential does, its server has plainly stored it, so every credential
// for that server minted before it is retired, under any account, in the
// same transaction (issue #325). That keeps one live credential per server,
// and retires one only once its successor is in use. Minting
// (linked-servers.ts) deletes nothing: the answer that carries a new
// credential can be lost, and the server would be left holding one that's
// already gone.
//
// Only earlier ones. A later credential is a successor the server may have
// stored and not yet connected with, and an older one reconnecting in that
// moment mustn't knock it out. One minted for an answer that never arrived
// stays until a newer credential signs in. After a credential's first
// sign-in nothing earlier is left, so a reconnect deletes nothing.
//
// Mint order is rowid order. tunnel_credentials has no INTEGER PRIMARY
// KEY, so its rowid is SQLite's own, and a new row's is always above every
// row already there. Only VACUUM could renumber it, and nothing runs one.
export function signInWithTunnelCredential(db: Database, token: string): { relayUserId: number; serverId: string | null } | null {
  return db.transaction(() => {
    const row = db
      .prepare(`SELECT rowid, relay_user_id, server_id FROM tunnel_credentials WHERE token = ? AND expires_at > datetime('now')`)
      .get(token) as { rowid: number; relay_user_id: number; server_id: string | null } | undefined;
    if (!row) return null;
    if (row.server_id) db.prepare("DELETE FROM tunnel_credentials WHERE server_id = ? AND rowid < ?").run(row.server_id, row.rowid);
    return { relayUserId: row.relay_user_id, serverId: row.server_id };
  })();
}
