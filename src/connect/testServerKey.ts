import * as ed from '@noble/ed25519'
import { identityProofMessage, serverIdForPublicKey } from './identity'

// Test-only: a home server's identity key, made and used the way
// server/src/auth/serverKey.ts does, so specs check real Ed25519 proofs.
// Not a *.spec.ts, so vitest never runs it as a suite of its own.

export function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

export function fakeServerKey() {
  const secret = ed.utils.randomSecretKey()
  const publicKey = b64url(ed.getPublicKey(secret))
  const serverId = serverIdForPublicKey(publicKey)!
  // `claimedId` lets a spoofer sign correctly with its own key while
  // naming another server's id.
  const prove = (nonce: string, claimedId = serverId) => ({
    serverId: claimedId,
    publicKey,
    signature: b64url(ed.sign(new TextEncoder().encode(identityProofMessage(claimedId, nonce)), secret)),
  })
  return { secret, publicKey, serverId, prove }
}
