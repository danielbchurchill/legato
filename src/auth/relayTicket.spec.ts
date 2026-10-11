import { describe, expect, it, vi } from 'vitest'
import { fetchRelayTicket, isUnderBase } from './relayTicket'

// Issue #365: the ticket that gets this device through legato.fm's relay.

const RELAY = 'http://127.0.0.1:8915'
const ID = '0123456789abcdef0123456789abcdef'
const BASE = `${RELAY}/relay/${ID}`

describe('isUnderBase', () => {
  it("is a relay base's own path and below, and a bare origin's whole origin", () => {
    expect(isUnderBase(`${BASE}/api/v1/stats`, BASE)).toBe(true)
    expect(isUnderBase(BASE, BASE)).toBe(true)
    expect(isUnderBase(`${BASE}0/api/v1/stats`, BASE)).toBe(false)
    expect(isUnderBase(`${RELAY}/auth/me`, BASE)).toBe(false)
    expect(isUnderBase('http://192.168.1.20:8899/api/v1/stats', 'http://192.168.1.20:8899')).toBe(true)
    expect(isUnderBase('http://192.168.1.21:8899/api/v1/stats', 'http://192.168.1.20:8899')).toBe(false)
  })
})

describe('fetchRelayTicket', () => {
  it("asks legato.fm with this device's session, and says why it didn't get one", async () => {
    const ok = vi.fn(async () => Response.json({ ticket: 'a.b.c', expiresAt: '2026-10-11T00:00:00.000Z' }))
    expect(await fetchRelayTicket(ID, { fetchImpl: ok as unknown as typeof fetch, relayOrigin: RELAY, relayToken: 'session' })).toEqual({
      ok: true,
      ticket: { ticket: 'a.b.c', expiresAt: '2026-10-11T00:00:00.000Z' },
    })
    expect(ok).toHaveBeenCalledWith(`${RELAY}/auth/relay-ticket`, {
      method: 'POST',
      headers: { Authorization: 'Bearer session', 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverId: ID }),
      credentials: 'omit',
    })

    const answer = (status: number, body: object) => (async () => Response.json(body, { status })) as unknown as typeof fetch
    const deps = { relayOrigin: RELAY, relayToken: 'session' }
    expect(await fetchRelayTicket(ID, { ...deps, fetchImpl: answer(401, {}) })).toEqual({ ok: false, failure: { kind: 'signed-out' } })
    expect(await fetchRelayTicket(ID, { ...deps, fetchImpl: answer(404, { reason: 'not_linked' }) })).toEqual({
      ok: false,
      failure: { kind: 'not-linked' },
    })
    expect(await fetchRelayTicket(ID, { ...deps, fetchImpl: answer(503, { error: 'signing is off' }) })).toEqual({
      ok: false,
      failure: { kind: 'relay', message: 'signing is off' },
    })
    expect(await fetchRelayTicket(ID, { relayOrigin: RELAY, relayToken: null })).toEqual({ ok: false, failure: { kind: 'signed-out' } })
  })
})
