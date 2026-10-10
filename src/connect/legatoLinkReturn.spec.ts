import { afterEach, describe, expect, it, vi } from 'vitest'
import { finishBrowserLink, hasLinkReturn, startBrowserLink, takeLinkReturn } from './legatoLinkReturn'

/* Issue #325: the web client links its server through legato.fm's /link
 * page and back, with PKCE. The verifier never leaves this tab, the code
 * comes back in the fragment and is out of the address bar before anything
 * renders, and the token it buys goes only to this server. */

const ISSUER = 'http://127.0.0.1:8912'
const HOME = 'http://192.168.1.20:8899'
const API = `${HOME}/api/v1`
const SERVER_ID = '0123456789abcdef0123456789abcdef'
const LINKED = { accountId: '7', email: 'rowan@example.com', name: 'Rowan' }

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

/** A tab at HOME: where it goes, and what's left in its address bar. */
function tab(hash = '') {
  const visits: string[] = []
  const location = { origin: HOME, pathname: '/', search: '', hash, assign: (url: string) => void visits.push(url) }
  const history = { state: null, replaceState: (_s: unknown, _t: string, url: string) => void (location.hash = new URL(url, HOME).hash) }
  return { location, history, visits }
}

type Call = { url: string; body: Record<string, unknown>; credentials: RequestCredentials | undefined }

// redeemed answers /link/redeem; a function can throw, as fetch does when
// legato.fm can't be reached.
function network(options: { redeemed?: Response | (() => Response); linked?: Response } = {}) {
  const calls: Call[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, body: JSON.parse(String(init?.body ?? '{}')), credentials: init?.credentials })
    if (url === `${ISSUER}/link/redeem`) {
      if (typeof options.redeemed === 'function') return options.redeemed()
      return options.redeemed ?? Response.json({ token: 'link.jws.token', expiresAt: '2026-10-09T12:10:00.000Z', scope: 'link' })
    }
    if (url === `${API}/auth/legato/link`) return options.linked ?? Response.json({ linked: LINKED })
    return new Response('not found', { status: 404 })
  }) as typeof fetch
  return { calls, fetchImpl }
}

async function started(storage: Storage) {
  const out = tab()
  startBrowserLink(SERVER_ID, ISSUER, { storage, location: out.location })
  const sent = new URL(out.visits[0]!)
  return { sent, verifier: (JSON.parse(storage.getItem('legato:link-pending')!) as { verifier: string }).verifier }
}

async function s256(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

describe('the web client linking through legato.fm', () => {
  afterEach(() => vi.unstubAllGlobals())

  it("leaves for the issuer's /link page with this server's id, this page's address, and the verifier's challenge", async () => {
    const storage = memoryStorage()
    const { sent, verifier } = await started(storage)
    expect(sent.origin + sent.pathname).toBe(`${ISSUER}/link`)
    expect(sent.searchParams.get('server')).toBe(SERVER_ID)
    expect(sent.searchParams.get('return_to')).toBe(`${HOME}/`)
    expect(sent.searchParams.get('code_challenge')).toBe(await s256(verifier))
    // The verifier itself never goes anywhere.
    expect(sent.href).not.toContain(verifier)
  })

  // A page on http://192.168.1.20:8899 isn't a secure context, so it has
  // getRandomValues but no crypto.subtle (caught in headless Chrome).
  it('starts on a page that has no crypto.subtle', async () => {
    const real = globalThis.crypto
    vi.stubGlobal('crypto', { getRandomValues: (bytes: Uint8Array<ArrayBuffer>) => real.getRandomValues(bytes) })
    const storage = memoryStorage()
    const out = tab()
    startBrowserLink(SERVER_ID, ISSUER, { storage, location: out.location })
    expect(out.visits).toHaveLength(1)
    vi.unstubAllGlobals()
    const { verifier } = JSON.parse(storage.getItem('legato:link-pending')!) as { verifier: string }
    expect(new URL(out.visits[0]!).searchParams.get('code_challenge')).toBe(await s256(verifier))
  })

  it('takes the code out of the address bar, then spends it with the verifier and hands the token to this server', async () => {
    const storage = memoryStorage()
    const { verifier } = await started(storage)
    const back = tab('#legato_link=the-one-time-code')
    takeLinkReturn({ ...back, storage })
    expect(back.location.hash).toBe('')
    expect(hasLinkReturn(storage)).toBe(true)

    const net = network()
    expect(await finishBrowserLink({ storage, fetchImpl: net.fetchImpl, apiBase: API })).toEqual({ ok: true, linked: LINKED })
    expect(net.calls).toEqual([
      { url: `${ISSUER}/link/redeem`, body: { code: 'the-one-time-code', code_verifier: verifier }, credentials: 'omit' },
      { url: `${API}/auth/legato/link`, body: { token: 'link.jws.token' }, credentials: undefined },
    ])
    // Spent: nothing left to finish.
    expect(hasLinkReturn(storage)).toBe(false)
    expect(await finishBrowserLink({ storage, fetchImpl: net.fetchImpl, apiBase: API })).toBeNull()
  })

  // An installed web app on iOS that opened legato.fm in Safari comes back
  // in Safari, which has no verifier; so does a tab restored without its
  // storage. The code can't be spent there, but the owner hears why.
  it("says the link didn't finish when a code or a cancel comes back to a tab with no verifier", async () => {
    for (const returned of ['#legato_link=someone-elses-code', '#legato_link=cancelled']) {
      const storage = memoryStorage()
      const lost = tab(returned)
      takeLinkReturn({ ...lost, storage })
      expect(lost.location.hash).toBe('')
      expect(hasLinkReturn(storage)).toBe(true)
      const net = network()
      expect(await finishBrowserLink({ storage, fetchImpl: net.fetchImpl, apiBase: API })).toEqual({ ok: false, failure: { step: 'lost' } })
      expect(net.calls).toEqual([])
      expect(hasLinkReturn(storage)).toBe(false)
    }
  })

  it('leaves an address without a code alone, and forgets a lost one when a new link starts', async () => {
    const storage = memoryStorage()
    const plain = tab('#other=1')
    takeLinkReturn({ ...plain, storage })
    expect(plain.location.hash).toBe('#other=1')
    expect(hasLinkReturn(storage)).toBe(false)

    takeLinkReturn({ ...tab('#legato_link=stray'), storage })
    await started(storage)
    expect(hasLinkReturn(storage)).toBe(false)
  })

  it('says the owner cancelled, and asks nobody anything', async () => {
    const storage = memoryStorage()
    await started(storage)
    takeLinkReturn({ ...tab('#legato_link=cancelled'), storage })
    const net = network()
    expect(await finishBrowserLink({ storage, fetchImpl: net.fetchImpl, apiBase: API })).toEqual({ ok: false, failure: { step: 'cancelled' } })
    expect(net.calls).toEqual([])
    expect(hasLinkReturn(storage)).toBe(false)
  })

  it("passes on legato.fm's refusal, and sends this server nothing", async () => {
    const storage = memoryStorage()
    await started(storage)
    takeLinkReturn({ ...tab('#legato_link=late'), storage })
    const error = 'This link code expired. Codes last five minutes; start again from your server\'s Settings.'
    const net = network({ redeemed: Response.json({ error, reason: 'expired' }, { status: 400 }) })
    expect(await finishBrowserLink({ storage, fetchImpl: net.fetchImpl, apiBase: API })).toEqual({
      ok: false,
      failure: { step: 'relay', message: error },
    })
    expect(net.calls.map((c) => c.url)).toEqual([`${ISSUER}/link/redeem`])
    // A refused code is spent: there's nothing to try again.
    expect(hasLinkReturn(storage)).toBe(false)
  })

  it('keeps the code through a rate limit or a dropped connection, and spends it on the next try', async () => {
    const storage = memoryStorage()
    const { verifier } = await started(storage)
    takeLinkReturn({ ...tab('#legato_link=patient'), storage })

    const error = 'Too many failed link attempts from this address. Try again in 60 seconds.'
    const limited = network({ redeemed: Response.json({ error, reason: 'rate_limited' }, { status: 429 }) })
    expect(await finishBrowserLink({ storage, fetchImpl: limited.fetchImpl, apiBase: API })).toEqual({
      ok: false,
      failure: { step: 'relay', message: error },
    })
    expect(hasLinkReturn(storage)).toBe(true)

    const offline = network({
      redeemed: () => {
        throw new TypeError('Failed to fetch')
      },
    })
    expect(await finishBrowserLink({ storage, fetchImpl: offline.fetchImpl, apiBase: API })).toEqual({
      ok: false,
      failure: { step: 'relay', message: "Couldn't reach legato.fm at 127.0.0.1:8912." },
    })
    expect(hasLinkReturn(storage)).toBe(true)

    const working = network()
    expect(await finishBrowserLink({ storage, fetchImpl: working.fetchImpl, apiBase: API })).toEqual({ ok: true, linked: LINKED })
    expect(working.calls[0]).toEqual({
      url: `${ISSUER}/link/redeem`,
      body: { code: 'patient', code_verifier: verifier },
      credentials: 'omit',
    })
    expect(hasLinkReturn(storage)).toBe(false)
  })

  it('spends a code once even when asked twice at the same time', async () => {
    const storage = memoryStorage()
    await started(storage)
    takeLinkReturn({ ...tab('#legato_link=once'), storage })
    const net = network()
    const [first, second] = await Promise.all([
      finishBrowserLink({ storage, fetchImpl: net.fetchImpl, apiBase: API }),
      finishBrowserLink({ storage, fetchImpl: net.fetchImpl, apiBase: API }),
    ])
    expect(first).toEqual({ ok: true, linked: LINKED })
    expect(second).toBeNull()
    expect(net.calls.filter((c) => c.url.endsWith('/link/redeem'))).toHaveLength(1)
  })

  it("passes on the server's refusal, and links on a second round trip", async () => {
    const storage = memoryStorage()
    await started(storage)
    takeLinkReturn({ ...tab('#legato_link=first'), storage })
    const error = "Couldn't reach http://127.0.0.1:8912 to record the link, so nothing changed."
    const failing = network({ linked: Response.json({ error, reason: 'legato_unreachable' }, { status: 502 }) })
    expect(await finishBrowserLink({ storage, fetchImpl: failing.fetchImpl, apiBase: API })).toEqual({
      ok: false,
      failure: { step: 'server', status: 502, reason: 'legato_unreachable', message: error },
    })

    await started(storage)
    takeLinkReturn({ ...tab('#legato_link=second'), storage })
    const working = network()
    expect(await finishBrowserLink({ storage, fetchImpl: working.fetchImpl, apiBase: API })).toEqual({ ok: true, linked: LINKED })
  })
})
