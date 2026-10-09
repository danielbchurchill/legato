import { describe, expect, it, vi } from 'vitest'
import { resolveRelayOrigin } from '../config/relayHost'
import {
  base64url,
  createPkcePair,
  readRelaySession,
  redeemCode,
  RelaySignInError,
  relaySignOut,
  signInWithRelay,
  storeRelaySession,
} from './relaySession'

const ORIGIN = 'http://127.0.0.1:8921'
const USER = { id: 1, provider: 'github', email: 'rowan@example.com', displayName: 'Rowan', avatarUrl: null }

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

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

describe('resolveRelayOrigin', () => {
  it('defaults to auth.legato.fm, and an empty env line falls back too', () => {
    expect(resolveRelayOrigin({})).toBe('https://auth.legato.fm')
    expect(resolveRelayOrigin({ VITE_RELAY_URL: '' })).toBe('https://auth.legato.fm')
  })

  it('takes a dev override, reduced to its origin', () => {
    expect(resolveRelayOrigin({ VITE_RELAY_URL: 'http://127.0.0.1:8921/' })).toBe(ORIGIN)
  })
})

describe('createPkcePair', () => {
  it('makes a 43-character verifier whose S256 is the challenge', async () => {
    const { verifier, challenge } = createPkcePair()
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
    expect(challenge).toBe(base64url(new Uint8Array(digest)))
  })

  // A page on http://192.168.1.20:8899 isn't a secure context, so it has
  // getRandomValues but no crypto.subtle (caught in headless Chrome, #325).
  it('works on a page that has no crypto.subtle', async () => {
    const real = globalThis.crypto
    vi.stubGlobal('crypto', { getRandomValues: (bytes: Uint8Array<ArrayBuffer>) => real.getRandomValues(bytes) })
    const { verifier, challenge } = createPkcePair()
    vi.unstubAllGlobals()
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
    expect(challenge).toBe(base64url(new Uint8Array(digest)))
  })

  it("matches RFC 7636 Appendix B's worked example", async () => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'))
    expect(base64url(new Uint8Array(digest))).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })
})

describe('signInWithRelay', () => {
  it('sends only the challenge over IPC, redeems with the verifier, and stores the session per relay origin', async () => {
    const storage = memoryStorage()
    const invoke = vi.fn(async () => ({ code: 'one-time', redirectUri: 'http://127.0.0.1:5000/callback' })) as never
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      json(200, { token: 'tok', expiresAt: '2026-11-01T00:00:00.000Z', user: USER }),
    )

    const user = await signInWithRelay('github', { invoke, storage, origin: ORIGIN, fetchImpl: fetchImpl as never })
    expect(user.displayName).toBe('Rowan')

    const [command, args] = (invoke as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(command).toBe('relay_sign_in')
    expect(args).toMatchObject({ relayOrigin: ORIGIN, provider: 'github' })
    expect(Object.keys(args)).not.toContain('verifier')

    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe(`${ORIGIN}/auth/token`)
    expect(init?.credentials).toBe('omit')
    const body = JSON.parse(String(init?.body)) as { code: string; code_verifier: string; redirect_uri: string }
    expect(body.code).toBe('one-time')
    expect(body.redirect_uri).toBe('http://127.0.0.1:5000/callback')
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.code_verifier))
    expect(base64url(new Uint8Array(digest))).toBe((args as { codeChallenge: string }).codeChallenge)

    expect(readRelaySession(storage, ORIGIN)).toEqual({ token: 'tok', expiresAt: '2026-11-01T00:00:00.000Z' })
    expect(readRelaySession(storage, 'https://auth.legato.fm')).toBeNull()
  })

  it("passes the Rust command's own error kind and message through", async () => {
    const invoke = vi.fn(async () => {
      throw { kind: 'timeout', message: 'Sign-in timed out' }
    }) as never
    const err = await signInWithRelay('google', { invoke, storage: memoryStorage(), origin: ORIGIN }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RelaySignInError)
    expect(err).toMatchObject({ kind: 'timeout', message: 'Sign-in timed out' })
  })
})

describe('redeemCode', () => {
  const callback = { code: 'c', redirectUri: 'http://127.0.0.1:5000/callback' }

  it("shows the relay's own reason for a refused code", async () => {
    const fetchImpl = vi.fn(async () => json(400, { error: 'invalid_grant', message: 'This sign-in code expired.' }))
    await expect(redeemCode(callback, 'v', ORIGIN, fetchImpl as never)).rejects.toThrow('This sign-in code expired.')
  })

  it('names the relay host when it cannot be reached at all', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Load failed')
    })
    await expect(redeemCode(callback, 'v', ORIGIN, fetchImpl as never)).rejects.toThrow(
      "Couldn't reach legato.fm at 127.0.0.1:8921. Check your internet connection and try again.",
    )
  })
})

describe('relaySignOut', () => {
  it('ends the session on the relay with the bearer token and forgets it locally', async () => {
    const storage = memoryStorage()
    storeRelaySession({ token: 'tok', expiresAt: 'x' }, storage, ORIGIN)
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => json(200, { ok: true }))
    await relaySignOut(storage, ORIGIN, fetchImpl as never)
    expect(fetchImpl.mock.calls[0]![1]?.headers).toEqual({ Authorization: 'Bearer tok' })
    expect(readRelaySession(storage, ORIGIN)).toBeNull()
  })

  it('still forgets the session when the relay is unreachable', async () => {
    const storage = memoryStorage()
    storeRelaySession({ token: 'tok', expiresAt: 'x' }, storage, ORIGIN)
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('offline')
    })
    await relaySignOut(storage, ORIGIN, fetchImpl as never)
    expect(readRelaySession(storage, ORIGIN)).toBeNull()
  })
})
