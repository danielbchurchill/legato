import { describe, expect, it } from 'vitest'
import { describeLinkFailure, linkWithLegato } from './legatoLink'

/* Issue #325: the desktop app links the server it's signed in to with its
 * own legato.fm session. legato.fm signs a `link` token for the server's id,
 * and the token goes to the server's link endpoint in the owner's session;
 * the server reports the link, signed, and stores the tunnel credential. */

const RELAY = 'http://127.0.0.1:8913'
const API = 'http://192.168.1.20:8899/api/v1'
const SERVER_ID = '0123456789abcdef0123456789abcdef'
const LINKED = { accountId: '7', email: 'rowan@example.com', name: 'Rowan' }

type Call = { url: string; authorization: string | null; credentials: RequestCredentials | undefined; body: unknown }

function network(options: { issued?: Response; linked?: Response; relayDown?: boolean } = {}) {
  const calls: Call[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({
      url,
      authorization: new Headers(init?.headers).get('Authorization'),
      credentials: init?.credentials,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    })
    if (url === `${RELAY}/auth/server-token`) {
      if (options.relayDown) throw new TypeError('Failed to fetch')
      return options.issued ?? Response.json({ token: 'link.jws.token', expiresAt: '2026-10-09T12:10:00.000Z', scope: 'link' })
    }
    if (url === `${API}/auth/legato/link`) return options.linked ?? Response.json({ linked: LINKED })
    return new Response('not found', { status: 404 })
  }) as typeof fetch
  return { calls, fetchImpl }
}

const deps = (net: ReturnType<typeof network>, relayToken: string | null = 'relay-session') => ({
  fetchImpl: net.fetchImpl,
  relayOrigin: RELAY,
  relayToken,
  apiBase: API,
})

describe('linkWithLegato', () => {
  it("asks legato.fm for a link token for this server's id and hands it to the server", async () => {
    const net = network()
    expect(await linkWithLegato(SERVER_ID, deps(net))).toEqual({ ok: true, linked: LINKED })
    expect(net.calls.map((c) => c.url)).toEqual([`${RELAY}/auth/server-token`, `${API}/auth/legato/link`])
    // legato.fm gets this app's own session and no cookie...
    expect(net.calls[0]).toMatchObject({
      authorization: 'Bearer relay-session',
      credentials: 'omit',
      body: { serverId: SERVER_ID, scope: 'link' },
    })
    // ...and the server gets the token in the body. Its own session header
    // is the app's fetch wrapper's job, never legato.fm's session.
    expect(net.calls[1]).toMatchObject({ authorization: null, body: { token: 'link.jws.token' } })
  })

  it('needs a legato.fm session, and asks nobody anything without one', async () => {
    const net = network()
    expect(await linkWithLegato(SERVER_ID, deps(net, null))).toEqual({ ok: false, failure: { step: 'signed-out' } })
    expect(net.calls).toEqual([])
  })

  it('says the legato.fm session ended when legato.fm no longer knows it', async () => {
    const net = network({ issued: Response.json({ error: 'Sign in to legato.fm first.', reason: 'signed_out' }, { status: 401 }) })
    expect(await linkWithLegato(SERVER_ID, deps(net))).toEqual({ ok: false, failure: { step: 'signed-out' } })
    expect(net.calls).toHaveLength(1)
  })

  it("sends the server nothing when legato.fm can't be reached or won't sign", async () => {
    const down = network({ relayDown: true })
    const result = await linkWithLegato(SERVER_ID, deps(down))
    expect(result).toEqual({ ok: false, failure: { step: 'relay', message: "Couldn't reach legato.fm at 127.0.0.1:8913." } })
    expect(down.calls).toHaveLength(1)

    const off = network({ issued: Response.json({ error: "legato.fm can't sign server tokens yet." }, { status: 503 }) })
    expect(await linkWithLegato(SERVER_ID, deps(off))).toEqual({
      ok: false,
      failure: { step: 'relay', message: "legato.fm can't sign server tokens yet." },
    })
    expect(off.calls).toHaveLength(1)
  })

  it("passes on the server's own refusal, which says nothing changed", async () => {
    const error = "Couldn't reach https://auth.legato.fm to record the link, so nothing changed. Check this server's internet connection and try again."
    const net = network({ linked: Response.json({ error, reason: 'legato_unreachable' }, { status: 502 }) })
    const result = await linkWithLegato(SERVER_ID, deps(net))
    expect(result).toEqual({ ok: false, failure: { step: 'server', status: 502, reason: 'legato_unreachable', message: error } })
    expect(describeLinkFailure((result as { ok: false; failure: Parameters<typeof describeLinkFailure>[0] }).failure)).toBe(error)
  })

  it('links on a second try after the first one failed', async () => {
    const error = "Couldn't reach https://auth.legato.fm to record the link, so nothing changed."
    const failing = network({ linked: Response.json({ error, reason: 'legato_unreachable' }, { status: 502 }) })
    expect((await linkWithLegato(SERVER_ID, deps(failing))).ok).toBe(false)
    const working = network()
    expect(await linkWithLegato(SERVER_ID, deps(working))).toEqual({ ok: true, linked: LINKED })
  })
})
