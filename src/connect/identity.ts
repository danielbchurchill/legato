import * as ed from '@noble/ed25519'
import { sha256, sha512 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

/* Checking that a server is the one its id says it is (issue #117), before
 * this client trusts it with anything worth stealing: a legato.fm access
 * token above all. A server's id is public and so is its mDNS
 * advertisement, so anything on the LAN can claim a linked server's id. Only
 * the real server holds the key the id is a hash of
 * (server/src/auth/serverKey.ts), so:
 *   1. make a fresh nonce here;
 *   2. ask the server to sign it (POST /api/v1/auth/identity);
 *   3. check that SHA-256(public key)'s first 128 bits are the expected id,
 *      and that the signature over this nonce verifies with that key.
 *
 * Verified in JavaScript (@noble/ed25519), not WebCrypto. A page the server
 * serves over plain http on the LAN isn't a secure context, and there
 * `crypto.subtle` doesn't exist at all (checked in WKWebView on macOS 26:
 * undefined on http://192.168.1.20:8899, Ed25519 fine on https). WebKitGTK's
 * WebCrypto Ed25519 depends on how the distribution built it. One
 * implementation runs everywhere instead. */

ed.hashes.sha512 = sha512

export type IdentityFailure = 'unreachable' | 'bad-response' | 'wrong-id' | 'wrong-key' | 'bad-signature'

export type IdentityResult = { ok: true; serverId: string; publicKey: string } | { ok: false; reason: IdentityFailure }

export function identityProofMessage(serverId: string, nonce: string): string {
  return `legato server identity proof\n${serverId}\n${nonce}`
}

function fromBase64url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4)
  try {
    return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))
  } catch {
    return null
  }
}

function toBase64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/** The id a public key (raw, base64url) belongs to: the server's own rule. */
export function serverIdForPublicKey(publicKey: string): string | null {
  const raw = fromBase64url(publicKey)
  return raw && raw.length === 32 ? bytesToHex(sha256(raw)).slice(0, 32) : null
}

export function newNonce(): string {
  return toBase64url(crypto.getRandomValues(new Uint8Array(32)))
}

/** True when the answer to `nonce` proves the server holds `expectedServerId`'s key. */
export function checkIdentityProof(
  expectedServerId: string,
  nonce: string,
  proof: { serverId?: unknown; publicKey?: unknown; signature?: unknown },
): IdentityResult {
  const { serverId, publicKey, signature } = proof
  if (typeof serverId !== 'string' || typeof publicKey !== 'string' || typeof signature !== 'string') {
    return { ok: false, reason: 'bad-response' }
  }
  if (serverId !== expectedServerId) return { ok: false, reason: 'wrong-id' }
  if (serverIdForPublicKey(publicKey) !== expectedServerId) return { ok: false, reason: 'wrong-key' }
  const signatureBytes = fromBase64url(signature)
  const keyBytes = fromBase64url(publicKey)
  if (!signatureBytes || signatureBytes.length !== 64 || !keyBytes) return { ok: false, reason: 'bad-signature' }
  let verified = false
  try {
    verified = ed.verify(signatureBytes, new TextEncoder().encode(identityProofMessage(serverId, nonce)), keyBytes)
  } catch {
    verified = false
  }
  return verified ? { ok: true, serverId, publicKey } : { ok: false, reason: 'bad-signature' }
}

export async function verifyServerIdentity(
  origin: string,
  expectedServerId: string,
  fetchImpl: typeof fetch = fetch,
  nonce: string = newNonce(),
): Promise<IdentityResult> {
  let res: Response
  try {
    res = await fetchImpl(`${origin}/api/v1/auth/identity`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce }),
      credentials: 'omit',
      signal: AbortSignal.timeout(8000),
    })
  } catch {
    return { ok: false, reason: 'unreachable' }
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (!res.ok || !body) return { ok: false, reason: 'bad-response' }
  return checkIdentityProof(expectedServerId, nonce, body)
}
