import { describe, expect, it } from 'vitest'
import { readSession, storeSession } from '../auth/session'
import { fakeServerKey } from './testServerKey'
import { renewDelayMs, renewLegatoSession, RENEW_WHEN_LEFT_MS, signInWithLegato } from './legatoSignIn'

/* Issue #117: signing in to a home server with legato.fm. The point of the
 * order: until the server proves it holds its id's key, legato.fm is never
 * asked for a token and the server is never sent one. */

const RELAY = 'http://127.0.0.1:8913'
const HOME = 'http://192.168.1.20:8899'

function memoryStorage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, value),
  }
}

type Call = { url: string; authorization: string | null }

/** legato.fm plus whatever answers at HOME, recording every request. */
function network(home: ReturnType<typeof fakeServerKey>, options: { claimId?: string; scope?: string; exchange?: Response } = {}) {
  const calls: Call[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, authorization: new Headers(init?.headers).get('Authorization') })
    if (url === `${HOME}/api/v1/auth/identity`) {
      const { nonce } = JSON.parse(String(init!.body)) as { nonce: string }
      return Response.json(home.prove(nonce, options.claimId))
    }
    if (url === `${RELAY}/auth/server-token`) {
      return Response.json({ token: 'access.jws.token', expiresAt: '2026-10-08T12:10:00.000Z', scope: options.scope ?? 'access' })
    }
    if (url === `${HOME}/api/v1/auth/legato/session`) {
      return options.exchange ?? Response.json({ token: 'sess', mediaTicket: 'tkt', expiresAt: '2026-10-09T00:00:00.000Z' })
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch
  return { calls, fetchImpl }
}

describe('signInWithLegato', () => {
  it('proves the server, gets an access token for its id, and swaps it for a session', async () => {
    const real = fakeServerKey()
    const net = network(real)
    const result = await signInWithLegato(HOME, real.serverId, { fetchImpl: net.fetchImpl, relayOrigin: RELAY, relayToken: 'relay-session' })
    expect(result).toEqual({
      ok: true,
      session: { token: 'sess', mediaTicket: 'tkt', legato: { serverId: real.serverId, expiresAt: '2026-10-09T00:00:00.000Z' } },
    })
    expect(net.calls.map((c) => c.url)).toEqual([
      `${HOME}/api/v1/auth/identity`,
      `${RELAY}/auth/server-token`,
      `${HOME}/api/v1/auth/legato/session`,
    ])
    expect(net.calls[1]!.authorization).toBe('Bearer relay-session')
    expect(net.calls[2]!.authorization).toBe('Bearer access.jws.token')
  })

  it('refuses a server with a different key claiming the same id, and sends it no token', async () => {
    const real = fakeServerKey()
    const spoofer = fakeServerKey()
    // The spoofer answers at the address, claiming the real server's id.
    const net = network(spoofer, { claimId: real.serverId })
    const result = await signInWithLegato(HOME, real.serverId, { fetchImpl: net.fetchImpl, relayOrigin: RELAY, relayToken: 'relay-session' })
    expect(result).toEqual({ ok: false, failure: { step: 'identity', reason: 'wrong-key' } })
    // legato.fm was never asked for a token, and the spoofer never got one.
    expect(net.calls.map((c) => c.url)).toEqual([`${HOME}/api/v1/auth/identity`])
    expect(net.calls.every((c) => c.authorization === null)).toBe(true)
  })

  it("doesn't send a link token: a server legato.fm won't open for this account isn't sent anything", async () => {
    const real = fakeServerKey()
    const net = network(real, { scope: 'link' })
    const result = await signInWithLegato(HOME, real.serverId, { fetchImpl: net.fetchImpl, relayOrigin: RELAY, relayToken: 'relay-session' })
    expect(result).toEqual({ ok: false, failure: { step: 'not-linked' } })
    expect(net.calls.some((c) => c.url.endsWith('/auth/legato/session'))).toBe(false)
  })

  it("passes on the server's own refusal, and needs a legato.fm session to start", async () => {
    const real = fakeServerKey()
    const refused = Response.json({ error: 'That legato.fm token was already used.', reason: 'token_used' }, { status: 409 })
    const net = network(real, { exchange: refused })
    const result = await signInWithLegato(HOME, real.serverId, { fetchImpl: net.fetchImpl, relayOrigin: RELAY, relayToken: 'relay-session' })
    expect(result).toEqual({
      ok: false,
      failure: { step: 'server', status: 409, reason: 'token_used', message: 'That legato.fm token was already used.' },
    })
    expect(await signInWithLegato(HOME, real.serverId, { fetchImpl: net.fetchImpl, relayOrigin: RELAY, relayToken: null })).toEqual({
      ok: false,
      failure: { step: 'signed-out' },
    })
  })
})

describe('renewal', () => {
  it('renews once less than eight hours are left, so twelve-hour sessions renew after four', () => {
    const now = Date.parse('2026-10-08T00:00:00.000Z')
    expect(renewDelayMs('2026-10-08T12:00:00.000Z', now)).toBe(4 * 60 * 60 * 1000)
    expect(renewDelayMs('2026-10-08T06:00:00.000Z', now)).toBe(0)
    expect(RENEW_WHEN_LEFT_MS).toBe(8 * 60 * 60 * 1000)
  })

  it('replaces the stored session with a fresh one, and leaves it alone when renewing fails', async () => {
    const real = fakeServerKey()
    const storage = memoryStorage()
    const old = { token: 'old', mediaTicket: 'old-tkt', legato: { serverId: real.serverId, expiresAt: '2026-10-08T12:00:00.000Z' } }
    storeSession(old, storage, HOME)

    const net = network(real)
    expect(await renewLegatoSession(HOME, { storage, fetchImpl: net.fetchImpl, relayOrigin: RELAY, relayToken: 'relay-session' })).toBe(true)
    expect(readSession(storage, HOME)?.token).toBe('sess')

    storeSession(old, storage, HOME)
    const spoofed = network(fakeServerKey(), { claimId: real.serverId })
    expect(await renewLegatoSession(HOME, { storage, fetchImpl: spoofed.fetchImpl, relayOrigin: RELAY, relayToken: 'relay-session' })).toBe(false)
    expect(readSession(storage, HOME)).toEqual(old)

    storeSession({ token: 'pw', mediaTicket: 'pw-tkt' }, storage, HOME)
    expect(await renewLegatoSession(HOME, { storage, fetchImpl: net.fetchImpl, relayOrigin: RELAY, relayToken: 'relay-session' })).toBe(false)
  })
})
