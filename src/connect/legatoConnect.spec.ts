import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readRelaySession } from '../auth/relaySession'
import { connectFailure, finishBrowserConnect, hasConnectReturn, startBrowserConnect, takeConnectReturn } from './legatoConnect'

/* Issue #365: a page a home server serves signs in to legato.fm, with its
 * server's say-so, through legato.fm's /connect and back. */

const RELAY = 'http://127.0.0.1:8915'
const PAGE = 'http://192.168.1.20:8899'
const API = `${PAGE}/api/v1`

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

const statement = (codeChallenge: string) => ({
  serverId: '0123456789abcdef0123456789abcdef',
  origin: PAGE,
  codeChallenge,
  expiresAt: 1_800_000_300,
  name: 'musicbox',
  signature: 's'.repeat(86),
})

function page(hash = '') {
  const assign = vi.fn()
  const replaceState = vi.fn()
  return {
    location: { origin: PAGE, pathname: '/', hash, search: '', assign },
    history: { state: null, replaceState },
    assign,
    replaceState,
  }
}

let storage: Storage
beforeEach(() => {
  storage = memoryStorage()
})

describe('startBrowserConnect', () => {
  it("asks this page's own server to vouch for it, then leaves for legato.fm with what it signed", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const { codeChallenge } = JSON.parse(String(init!.body)) as { codeChallenge: string }
      return Response.json(statement(codeChallenge))
    })
    const here = page()
    expect(
      await startBrowserConnect({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        apiBase: API,
        relayOrigin: RELAY,
        storage,
        location: here.location,
      }),
    ).toBeNull()
    expect(fetchImpl.mock.calls[0]![0]).toBe(`${API}/auth/legato/web-client`)

    const target = new URL(here.assign.mock.calls[0]![0] as string)
    expect(`${target.origin}${target.pathname}`).toBe(`${RELAY}/connect`)
    const sent = (JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body)) as { codeChallenge: string }).codeChallenge
    expect(Object.fromEntries(target.searchParams)).toEqual({
      server: '0123456789abcdef0123456789abcdef',
      return_to: `${PAGE}/`,
      code_challenge: sent,
      name: 'musicbox',
      expires: '1800000300',
      signature: 's'.repeat(86),
    })
    // The verifier stays in this tab.
    expect(storage.getItem('legato:connect-pending')).toContain(RELAY)
    expect(target.href).not.toContain(JSON.parse(storage.getItem('legato:connect-pending')!).verifier)
  })

  it("says why when the server won't, and goes nowhere", async () => {
    const refused = (async () =>
      Response.json({ error: 'Link this server to legato.fm in Settings first.' }, { status: 409 })) as unknown as typeof fetch
    const here = page()
    expect(await startBrowserConnect({ fetchImpl: refused, apiBase: API, relayOrigin: RELAY, storage, location: here.location })).toBe(
      'Link this server to legato.fm in Settings first.',
    )
    expect(here.assign).not.toHaveBeenCalled()
    expect(storage.getItem('legato:connect-pending')).toBeNull()
  })
})

describe('coming back from legato.fm', () => {
  async function started() {
    const fetchImpl = (async (_url: string, init?: RequestInit) =>
      Response.json(statement((JSON.parse(String(init!.body)) as { codeChallenge: string }).codeChallenge))) as unknown as typeof fetch
    await startBrowserConnect({ fetchImpl, apiBase: API, relayOrigin: RELAY, storage, location: page().location })
    return JSON.parse(storage.getItem('legato:connect-pending')!) as { verifier: string }
  }

  it('takes the code out of the address bar, spends it once with the verifier, and keeps the session', async () => {
    const { verifier } = await started()
    const back = page('#legato_connect=the-code')
    takeConnectReturn({ location: back.location, history: back.history, storage })
    expect(back.replaceState).toHaveBeenCalledWith(null, '', '/')
    expect(hasConnectReturn(storage)).toBe(true)

    const sessions = memoryStorage()
    const fetchImpl = vi.fn(async () =>
      Response.json({ token: 'web-session', expiresAt: '2026-11-09T00:00:00.000Z', user: { id: 1, displayName: 'Rowan' }, serverId: 'x' }),
    )
    const result = await finishBrowserConnect({ fetchImpl: fetchImpl as unknown as typeof fetch, storage, sessions })
    expect(result).toMatchObject({ ok: true, user: { displayName: 'Rowan' } })
    expect(fetchImpl).toHaveBeenCalledWith(`${RELAY}/connect/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'the-code', code_verifier: verifier }),
      credentials: 'omit',
    })
    expect(readRelaySession(sessions, RELAY)).toEqual({ token: 'web-session', expiresAt: '2026-11-09T00:00:00.000Z' })
    expect(hasConnectReturn(storage)).toBe(false)
    expect(await finishBrowserConnect({ fetchImpl: fetchImpl as unknown as typeof fetch, storage, sessions })).toBeNull()
  })

  it('says it was cancelled, or lost when this tab has no verifier, and keeps a code legato.fm never answered for', async () => {
    await started()
    const cancelled = page('#legato_connect=cancelled')
    takeConnectReturn({ location: cancelled.location, history: cancelled.history, storage })
    expect(await finishBrowserConnect({ storage })).toEqual({ ok: false, failure: { step: 'cancelled' } })

    const elsewhere = memoryStorage()
    const lost = page('#legato_connect=a-code')
    takeConnectReturn({ location: lost.location, history: lost.history, storage: elsewhere })
    expect(await finishBrowserConnect({ storage: elsewhere })).toEqual({ ok: false, failure: { step: 'lost' } })

    await started()
    const back = page('#legato_connect=the-code')
    takeConnectReturn({ location: back.location, history: back.history, storage })
    const down = (async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    expect(await finishBrowserConnect({ fetchImpl: down, storage })).toMatchObject({ ok: false, failure: { step: 'relay' } })
    expect(hasConnectReturn(storage)).toBe(true)
    expect(connectFailure()).toBeNull()
  })
})
