import { describe, expect, it, vi } from 'vitest'
import { checkIdentityProof, newNonce, serverIdForPublicKey, verifyServerIdentity } from './identity'
import { b64url, fakeServerKey } from './testServerKey'

/* Issue #117: a client checks a server's identity before it trusts it. The
 * key and signatures here are real Ed25519, made the way
 * server/src/auth/serverKey.ts makes them. */

describe('serverIdForPublicKey', () => {
  it('matches the server: the first 128 bits of SHA-256 over the raw key, as hex', () => {
    // Bytes 0..31, hashed by node:crypto the way server/src/auth/serverKey.ts does.
    expect(serverIdForPublicKey('AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8')).toBe('630dcd2966c4336691125448bbb25b4f')
    expect(serverIdForPublicKey('not base64url!')).toBeNull()
    expect(serverIdForPublicKey(b64url(new Uint8Array(16)))).toBeNull()
  })
})

describe('checkIdentityProof', () => {
  it("accepts the real server's signature over this nonce", () => {
    const server = fakeServerKey()
    const nonce = newNonce()
    expect(checkIdentityProof(server.serverId, nonce, server.prove(nonce))).toEqual({
      ok: true,
      serverId: server.serverId,
      publicKey: server.publicKey,
    })
  })

  it('refuses a server with a different key claiming the same id', () => {
    const real = fakeServerKey()
    const spoofer = fakeServerKey()
    const nonce = newNonce()
    // It signs correctly with its own key, and names the real id.
    expect(checkIdentityProof(real.serverId, nonce, spoofer.prove(nonce, real.serverId))).toEqual({ ok: false, reason: 'wrong-key' })
  })

  it("refuses the real server's public key with someone else's signature", () => {
    const real = fakeServerKey()
    const spoofer = fakeServerKey()
    const nonce = newNonce()
    const forged = { ...spoofer.prove(nonce, real.serverId), publicKey: real.publicKey }
    expect(checkIdentityProof(real.serverId, nonce, forged)).toEqual({ ok: false, reason: 'bad-signature' })
  })

  it('refuses a replayed proof of an earlier nonce, another id, and junk', () => {
    const server = fakeServerKey()
    const old = server.prove(newNonce())
    expect(checkIdentityProof(server.serverId, newNonce(), old)).toEqual({ ok: false, reason: 'bad-signature' })
    expect(checkIdentityProof('f'.repeat(32), 'n'.repeat(43), server.prove('n'.repeat(43)))).toEqual({ ok: false, reason: 'wrong-id' })
    expect(checkIdentityProof(server.serverId, 'x', {})).toEqual({ ok: false, reason: 'bad-response' })
    expect(checkIdentityProof(server.serverId, 'x', { ...server.prove('x'), signature: 'short' })).toEqual({
      ok: false,
      reason: 'bad-signature',
    })
  })
})

describe('verifyServerIdentity', () => {
  it('sends a fresh nonce to POST /api/v1/auth/identity and checks the answer', async () => {
    const server = fakeServerKey()
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const { nonce } = JSON.parse(String(init!.body)) as { nonce: string }
      return Response.json(server.prove(nonce))
    })
    const result = await verifyServerIdentity('http://192.168.1.20:8899', server.serverId, fetchImpl as typeof fetch)
    expect(result.ok).toBe(true)
    expect(fetchImpl.mock.calls[0]![0]).toBe('http://192.168.1.20:8899/api/v1/auth/identity')
    expect(fetchImpl.mock.calls[0]![1]!.credentials).toBe('omit')
    const sent = JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body)) as { nonce: string }
    expect(sent.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('says unreachable when nothing answers, and bad-response for an error', async () => {
    const server = fakeServerKey()
    const down = (async () => {
      throw new TypeError('Failed to fetch')
    }) as typeof fetch
    expect(await verifyServerIdentity('http://x:1', server.serverId, down)).toEqual({ ok: false, reason: 'unreachable' })
    const old = (async () => new Response('{"error":"no"}', { status: 401 })) as typeof fetch
    expect(await verifyServerIdentity('http://x:1', server.serverId, old)).toEqual({ ok: false, reason: 'bad-response' })
  })
})
