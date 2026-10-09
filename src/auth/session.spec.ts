import { describe, expect, it, vi } from 'vitest'
import { createAuthFetch, readSession, storeSession, withMediaTicket } from './session'

const ORIGIN = 'http://100.100.20.30:8899'

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

function setup(status = 200) {
  const storage = memoryStorage()
  const baseFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status }))
  const onAuthRequired = vi.fn()
  const authFetch = createAuthFetch({
    baseFetch: baseFetch as unknown as typeof fetch,
    origin: ORIGIN,
    storage,
    onAuthRequired,
    pageUrl: 'tauri://localhost/',
  })
  return { storage, baseFetch, onAuthRequired, authFetch }
}

function sentHeaders(baseFetch: ReturnType<typeof setup>['baseFetch']): Headers {
  return new Headers(baseFetch.mock.calls[0]![1]!.headers)
}

describe('createAuthFetch', () => {
  it("adds the bearer token to this server's requests", async () => {
    const { storage, baseFetch, authFetch } = setup()
    storeSession({ token: 'tok', mediaTicket: 'tkt' }, storage, ORIGIN)
    await authFetch(`${ORIGIN}/api/v1/stats`)
    expect(sentHeaders(baseFetch).get('Authorization')).toBe('Bearer tok')
  })

  it('keeps the headers a caller already set', async () => {
    const { storage, baseFetch, authFetch } = setup()
    storeSession({ token: 'tok', mediaTicket: 'tkt' }, storage, ORIGIN)
    await authFetch(`${ORIGIN}/api/v1/playlists`, { method: 'POST', headers: { 'Content-Type': 'application/json' } })
    expect(sentHeaders(baseFetch).get('Content-Type')).toBe('application/json')
    expect(sentHeaders(baseFetch).get('Authorization')).toBe('Bearer tok')
  })

  it('never sends the token to another origin', async () => {
    const { storage, baseFetch, authFetch } = setup()
    storeSession({ token: 'tok', mediaTicket: 'tkt' }, storage, ORIGIN)
    await authFetch('https://musicbrainz.org/ws/2/artist')
    expect(baseFetch.mock.calls[0]![1]).toBeUndefined()
  })

  it('drops the session and reports it when the server stops accepting it', async () => {
    const { storage, onAuthRequired, authFetch } = setup(401)
    storeSession({ token: 'tok', mediaTicket: 'tkt' }, storage, ORIGIN)
    await authFetch(`${ORIGIN}/api/v1/stats`)
    expect(readSession(storage, ORIGIN)).toBeNull()
    expect(onAuthRequired).toHaveBeenCalledOnce()
  })

  // #117: useAuth renews it through legato.fm first, and clears it only if
  // that fails.
  it('keeps a legato.fm session for renewal, and still reports it', async () => {
    const { storage, onAuthRequired, authFetch } = setup(401)
    const legato = { serverId: '0123456789abcdef0123456789abcdef', expiresAt: '2026-10-08T12:00:00.000Z' }
    storeSession({ token: 'tok', mediaTicket: 'tkt', legato }, storage, ORIGIN)
    await authFetch(`${ORIGIN}/api/v1/stats`)
    expect(readSession(storage, ORIGIN)).toEqual({ token: 'tok', mediaTicket: 'tkt', legato })
    expect(onAuthRequired).toHaveBeenCalledOnce()
  })

  it("leaves a wrong password to the form that sent it", async () => {
    const { onAuthRequired, authFetch } = setup(401)
    await authFetch(`${ORIGIN}/api/v1/auth/sign-in`, { method: 'POST' })
    expect(onAuthRequired).not.toHaveBeenCalled()
  })

  // #119: a read the network failed may have left something on screen
  // without its data, so the next outage that ends reads everything again.
  it('reports a request the network failed, but not one that was aborted', async () => {
    const onNetworkError = vi.fn()
    const baseFetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new DOMException('The operation was aborted.', 'AbortError'))
    const authFetch = createAuthFetch({
      baseFetch: baseFetch as unknown as typeof fetch,
      origin: ORIGIN,
      storage: memoryStorage(),
      onAuthRequired: () => undefined,
      onNetworkError,
      pageUrl: 'tauri://localhost/',
    })

    await expect(authFetch(`${ORIGIN}/api/v1/playlists`)).rejects.toThrow('Failed to fetch')
    expect(onNetworkError).toHaveBeenCalledTimes(1)
    await expect(authFetch(`${ORIGIN}/api/v1/playlists`)).rejects.toThrow('aborted')
    expect(onNetworkError).toHaveBeenCalledTimes(1)
  })
})

describe('withMediaTicket', () => {
  const session = { token: 'tok', mediaTicket: 'a/b+c' }

  it('appends the ticket as the first or a further query param', () => {
    expect(withMediaTicket(`${ORIGIN}/api/v1/files/1/stream`, session)).toBe(`${ORIGIN}/api/v1/files/1/stream?t=a%2Fb%2Bc`)
    expect(withMediaTicket(`${ORIGIN}/api/v1/covers/x?size=thumb`, session)).toBe(
      `${ORIGIN}/api/v1/covers/x?size=thumb&t=a%2Fb%2Bc`,
    )
  })

  it('leaves the URL alone when signed out', () => {
    expect(withMediaTicket(`${ORIGIN}/api/v1/ws`, null)).toBe(`${ORIGIN}/api/v1/ws`)
  })
})
