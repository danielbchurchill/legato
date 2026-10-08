import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import type { Database } from "../sqlite.js";

// This server's identity key (issue #231, migration 0037). legato.fm signs
// `access` tokens only for servers an account has linked, and it records a
// link only when the server proves the id is its own. The id is public
// (GET /auth/status), so the proof can't be "I say I'm this id". It's a
// signature from this key. The id is derived from the public key, so
// another server can't produce a proof for this id with a key of its own.
//
// The other half is relay/src/linked-servers.ts, which checks these proofs.
// The message formats below must match it byte for byte;
// relay/src/linked-servers.spec.ts runs this file's proofs through it.

// The first 128 bits of SHA-256 over the raw 32-byte public key, as 32
// lowercase hex characters: the same shape 0032's random ids had, so
// nothing that reads an id has to change.
export function serverIdForPublicKey(publicKey: string): string {
  return createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("hex").slice(0, 32);
}

// The JWK `x` of an Ed25519 key: the raw public key as base64url.
function publicKeyOf(privateKey: KeyObject): string {
  return (createPublicKey(privateKey).export({ format: "jwk" }) as { x: string }).x;
}

// Makes the key the first time this database is opened without one, and
// moves server_id onto it. Returns the old and new id when it did, so
// startup can log the change once; null every time after.
//
// A server from before 0037 had a random id, and this replaces it. That
// only matters to a token issued for the old id, which lasts ten minutes,
// and to a legato.fm link, which has to be made again anyway: legato.fm
// didn't record links before #231, so it signs `access` for none of them
// until the owner links once more.
export function ensureServerKey(db: Database): { from: string; to: string } | null {
  const row = db.prepare("SELECT server_id, private_key FROM server_identity WHERE id = 1").get() as {
    server_id: string;
    private_key: string | null;
  };
  if (row.private_key) return null;
  const { privateKey } = generateKeyPairSync("ed25519");
  const serverId = serverIdForPublicKey(publicKeyOf(privateKey));
  const changed = db
    .prepare("UPDATE server_identity SET private_key = ?, server_id = ? WHERE id = 1 AND private_key IS NULL")
    .run(privateKey.export({ format: "pem", type: "pkcs8" }) as string, serverId).changes;
  return changed > 0 ? { from: row.server_id, to: serverId } : null;
}

export type ServerKey = { serverId: string; publicKey: string; privateKey: KeyObject };

export function loadServerKey(db: Database): ServerKey {
  ensureServerKey(db);
  const row = db.prepare("SELECT server_id, private_key FROM server_identity WHERE id = 1").get() as {
    server_id: string;
    private_key: string;
  };
  const privateKey = createPrivateKey(row.private_key);
  return { serverId: row.server_id, publicKey: publicKeyOf(privateKey), privateKey };
}

function signMessage(key: ServerKey, message: string): string {
  return sign(null, Buffer.from(message), key.privateKey).toString("base64url");
}

// What POST <legato.fm>/linked-servers takes once the link endpoint has
// verified a `link` token: the token itself, signed. The token already
// names the account, this server, legato.fm and its own expiry, and
// legato.fm spends its jti, so the proof works once, for that link only.
export function linkProof(key: ServerKey, linkToken: string) {
  return { publicKey: key.publicKey, linkToken, signature: signMessage(key, `legato.fm link proof\n${linkToken}`) };
}

// What POST /api/v1/auth/identity answers (issue #117). Before a client
// sends a server a legato.fm access token, it has the server sign a nonce
// the client just made, and checks that the public key hashes to the id it
// expects and that the signature verifies (src/connect/identity.ts). Without
// that, anything on the LAN that answers with a linked server's id would
// receive the owner's token. The prefix keeps it from ever reading as a link
// or unlink proof, and the nonce can't carry a newline into the message.
export const IDENTITY_NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export function identityProofMessage(serverId: string, nonce: string): string {
  return `legato server identity proof\n${serverId}\n${nonce}`;
}

export function identityProof(key: ServerKey, nonce: string) {
  return { serverId: key.serverId, publicKey: key.publicKey, signature: signMessage(key, identityProofMessage(key.serverId, nonce)) };
}

// What POST <legato.fm>/linked-servers/unlink takes once the owner unlinks
// an account here. Names the service it's for, so it can't be replayed at
// another one, and carries the time and a nonce legato.fm spends.
export function unlinkProof(key: ServerKey, input: { issuer: string; accountId: string; nowSeconds: number }) {
  const nonce = randomBytes(16).toString("base64url");
  const message = ["legato.fm unlink proof", input.issuer, key.serverId, input.accountId, String(input.nowSeconds), nonce].join("\n");
  return {
    publicKey: key.publicKey,
    accountId: input.accountId,
    issuedAt: input.nowSeconds,
    nonce,
    signature: signMessage(key, message),
  };
}
