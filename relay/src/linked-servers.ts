import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import type { Database } from "./sqlite.js";
import { verifyIssuedToken, type SigningKeys } from "./signing-keys.js";

// Which home servers each account has linked (issue #231, migration 0005).
// A pair means "this account has linked this server", and it's the only
// thing that gets an account an `access` token for a server
// (routes/auth.ts). legato.fm takes no one's word for a pair: the server
// itself proves it, with a signature from its identity key.
//
// Why a key: a server's id is public (GET /api/v1/auth/status), so a pair
// recorded on anyone's say-so would let a hostile server claim a real
// server's id and collect the access tokens meant for it. So the id is
// derived from the key. Each server makes an Ed25519 key once
// (server/src/auth/serverKey.ts), and its id is the first 128 bits of the
// SHA-256 of the public key. A proof carries the public key, legato.fm
// checks the id against it, and only the holder of the private key can
// sign for that id. A different server can't replay the proof as its own,
// because its key hashes to a different id.
//
// Each proof is bound to one account and used once:
//   - Link: the server signs the `link` token it just verified, which names
//     the account (sub), the server (aud), this service (iss) and its own
//     expiry, and carries a random jti that's spent here.
//   - Unlink: the server signs the account, its id, this service, the time
//     and a random nonce, which is spent here once it removes a pair.
// #237's claim flow can reuse the same signature check for its pairing code.

// Each proof starts with its own prefix, so a link proof can never be read
// as an unlink proof, or as anything else the key signs later.
const LINK_PROOF_PREFIX = "legato.fm link proof\n";
const UNLINK_PROOF_PREFIX = "legato.fm unlink proof\n";

// How far an unlink proof's issuedAt may be from this service's clock,
// either way. Generous enough for a home server whose clock has drifted.
export const UNLINK_PROOF_WINDOW_SECONDS = 5 * 60;

// The JWK `x` of an Ed25519 public key: 32 bytes as base64url, no padding.
const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
// relay_users.id, as a token's `sub` carries it.
const ACCOUNT_ID_PATTERN = /^[1-9][0-9]{0,15}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export function serverIdForPublicKey(publicKey: string): string {
  return createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("hex").slice(0, 32);
}

export function linkProofMessage(linkToken: string): string {
  return `${LINK_PROOF_PREFIX}${linkToken}`;
}

export function unlinkProofMessage(input: {
  issuer: string;
  serverId: string;
  accountId: string;
  issuedAt: number;
  nonce: string;
}): string {
  return `${UNLINK_PROOF_PREFIX}${input.issuer}\n${input.serverId}\n${input.accountId}\n${input.issuedAt}\n${input.nonce}`;
}

function importServerKey(publicKey: string): KeyObject | null {
  if (!PUBLIC_KEY_PATTERN.test(publicKey)) return null;
  try {
    return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey }, format: "jwk" });
  } catch {
    return null;
  }
}

export function verifyServerSignature(publicKey: string, message: string, signature: string): boolean {
  const key = importServerKey(publicKey);
  if (!key) return false;
  const bytes = Buffer.from(signature, "base64url");
  return bytes.length === 64 && verify(null, Buffer.from(message), key, bytes);
}

export function isLinkedServer(db: Database, relayUserId: number, serverId: string): boolean {
  return db.prepare("SELECT 1 FROM linked_servers WHERE relay_user_id = ? AND server_id = ?").get(relayUserId, serverId) !== undefined;
}

// Linking again keeps the pair and moves linked_at. The public key can't
// differ for the same id, short of a SHA-256 collision.
function recordLinkedServer(db: Database, relayUserId: number, serverId: string, publicKey: string): void {
  db.prepare(
    `INSERT INTO linked_servers (relay_user_id, server_id, public_key) VALUES (?, ?, ?)
     ON CONFLICT (relay_user_id, server_id) DO UPDATE SET public_key = excluded.public_key, linked_at = datetime('now')`,
  ).run(relayUserId, serverId, publicKey);
}

export function removeLinkedServer(db: Database, relayUserId: number, serverId: string): boolean {
  return db.prepare("DELETE FROM linked_servers WHERE relay_user_id = ? AND server_id = ?").run(relayUserId, serverId).changes > 0;
}

// False when the proof was already spent. Rows past their expiry go first:
// a proof that old is refused before it gets here, so its row has no job.
function spendProof(db: Database, proofId: string, expiresAtSeconds: number, nowSeconds: number): boolean {
  db.prepare("DELETE FROM spent_server_proofs WHERE expires_at < datetime(?, 'unixepoch')").run(nowSeconds);
  return (
    db
      .prepare("INSERT OR IGNORE INTO spent_server_proofs (proof_id, expires_at) VALUES (?, datetime(?, 'unixepoch'))")
      .run(proofId, expiresAtSeconds).changes > 0
  );
}

export type ProofFailure = "malformed" | "bad_token" | "wrong_key" | "bad_signature" | "stale" | "used" | "no_account";

export const PROOF_FAILURE_MESSAGES: Record<ProofFailure, string> = {
  malformed: "That isn't a well-formed server proof.",
  bad_token: "That link token wasn't issued by this service, has expired, or isn't a link token.",
  wrong_key: "That public key doesn't match the server id in the proof.",
  bad_signature: "The proof's signature doesn't match the server's public key.",
  stale: "That proof is too old, or the server's clock is off by more than five minutes.",
  used: "That proof has already been used. Link again with a fresh token.",
  no_account: "The legato.fm account in that proof no longer exists.",
};

export type ProofResult = { ok: true; relayUserId: number; serverId: string; changed: boolean } | { ok: false; reason: ProofFailure };

function strings<K extends string>(body: Record<string, unknown> | null | undefined, keys: K[]): Record<K, string> | null {
  if (!body) return null;
  for (const key of keys) if (typeof body[key] !== "string") return null;
  return body as Record<K, string>;
}

// A server reports that its link endpoint verified this link token
// (server/src/routes/auth.ts) and signs the token to prove it's the server
// the token was for. Only a `link` token counts: a server is handed `access`
// tokens on every request, and one of those mustn't be able to bring back a
// pair the account has just removed.
export function acceptLinkProof(
  db: Database,
  keys: SigningKeys,
  issuer: string,
  body: Record<string, unknown> | null | undefined,
  nowSeconds = Math.floor(Date.now() / 1000),
): ProofResult {
  const proof = strings(body, ["publicKey", "linkToken", "signature"]);
  if (!proof) return { ok: false, reason: "malformed" };
  const claims = verifyIssuedToken(keys, proof.linkToken, { issuer, nowSeconds });
  if (!claims || claims.scope !== "link" || !ACCOUNT_ID_PATTERN.test(claims.sub)) return { ok: false, reason: "bad_token" };
  if (!PUBLIC_KEY_PATTERN.test(proof.publicKey) || serverIdForPublicKey(proof.publicKey) !== claims.aud) {
    return { ok: false, reason: "wrong_key" };
  }
  if (!verifyServerSignature(proof.publicKey, linkProofMessage(proof.linkToken), proof.signature)) {
    return { ok: false, reason: "bad_signature" };
  }

  const relayUserId = Number(claims.sub);
  return db.transaction((): ProofResult => {
    if (!db.prepare("SELECT 1 FROM relay_users WHERE id = ?").get(relayUserId)) return { ok: false, reason: "no_account" };
    if (!spendProof(db, `link:${claims.jti}`, claims.exp, nowSeconds)) return { ok: false, reason: "used" };
    const changed = !isLinkedServer(db, relayUserId, claims.aud);
    recordLinkedServer(db, relayUserId, claims.aud, proof.publicKey);
    return { ok: true, relayUserId, serverId: claims.aud, changed };
  })();
}

// A server reports that its owner unlinked this account. The pair may
// already be gone (the account revoked it here first); that's still a
// success, with changed: false, and writes nothing. Only a proof that
// removes a pair spends its nonce: anyone can make a key and sign a valid
// unlink proof for it, and with no session to limit, spending every one
// would let them fill spent_server_proofs for free.
export function acceptUnlinkProof(
  db: Database,
  issuer: string,
  body: Record<string, unknown> | null | undefined,
  nowSeconds = Math.floor(Date.now() / 1000),
): ProofResult {
  const proof = strings(body, ["publicKey", "accountId", "nonce", "signature"]);
  const issuedAt = body?.issuedAt;
  if (!proof || typeof issuedAt !== "number" || !Number.isSafeInteger(issuedAt)) return { ok: false, reason: "malformed" };
  if (!ACCOUNT_ID_PATTERN.test(proof.accountId) || !NONCE_PATTERN.test(proof.nonce)) return { ok: false, reason: "malformed" };
  if (!PUBLIC_KEY_PATTERN.test(proof.publicKey)) return { ok: false, reason: "wrong_key" };
  if (Math.abs(nowSeconds - issuedAt) > UNLINK_PROOF_WINDOW_SECONDS) return { ok: false, reason: "stale" };

  const serverId = serverIdForPublicKey(proof.publicKey);
  const message = unlinkProofMessage({ issuer, serverId, accountId: proof.accountId, issuedAt, nonce: proof.nonce });
  if (!verifyServerSignature(proof.publicKey, message, proof.signature)) return { ok: false, reason: "bad_signature" };

  const relayUserId = Number(proof.accountId);
  return db.transaction((): ProofResult => {
    if (!isLinkedServer(db, relayUserId, serverId)) return { ok: true, relayUserId, serverId, changed: false };
    if (!spendProof(db, `unlink:${proof.nonce}`, issuedAt + UNLINK_PROOF_WINDOW_SECONDS, nowSeconds)) {
      return { ok: false, reason: "used" };
    }
    removeLinkedServer(db, relayUserId, serverId);
    return { ok: true, relayUserId, serverId, changed: true };
  })();
}
