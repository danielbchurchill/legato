import { sha256 } from '@noble/hashes/sha2.js'
import { RELAY_ORIGIN } from '../config/relayHost'

/* The desktop app's own legato.fm session (issue #215), separate from the
 * home server's session in session.ts.
 *
 * Sign-in is OAuth for native apps with PKCE: this module makes the
 * verifier and its S256 challenge, the Rust command relay_sign_in
 * (src-tauri/src/relay_sign_in.rs) runs the loopback listener and the system
 * browser and hands back a one-time code, and this module redeems that code
 * plus the verifier at the relay's POST /auth/token for a bearer token. The
 * verifier never leaves this process until redemption; the token never goes
 * into a URL or the browser.
 *
 * The token sits in localStorage, keyed by relay origin, the same as
 * session.ts keeps the server's: same per-app WebView storage, and a dev
 * relay's token is never sent to production. It's deliberately not added to
 * installAuthFetch, which only wraps the home server's origin; the calls
 * below set their own Authorization header, and never send cookies. */

export type RelayProvider = 'google' | 'github'

export type RelayUser = {
  id: number
  provider: RelayProvider
  email: string | null
  displayName: string | null
  avatarUrl: string | null
}

export type RelayMe = { user: RelayUser | null; configured: Record<RelayProvider, boolean> }

export type StoredRelaySession = { token: string; expiresAt: string }

/** What relay_sign_in returns on success. */
export type LoopbackCallback = { code: string; redirectUri: string }

/** Every way a sign-in can fail, with the sentence the settings row shows.
 * The Rust command's errors arrive already in this shape ({ kind, message }). */
export class RelaySignInError extends Error {
  kind: string
  constructor(kind: string, message: string) {
    super(message)
    this.kind = kind
  }
}

const storageKey = (origin: string) => `legato:relay-session:${origin}`

export function readRelaySession(storage: Storage = localStorage, origin = RELAY_ORIGIN): StoredRelaySession | null {
  try {
    const raw = storage.getItem(storageKey(origin))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StoredRelaySession>
    return typeof parsed.token === 'string' && typeof parsed.expiresAt === 'string'
      ? { token: parsed.token, expiresAt: parsed.expiresAt }
      : null
  } catch {
    return null
  }
}

export function storeRelaySession(session: StoredRelaySession, storage: Storage = localStorage, origin = RELAY_ORIGIN): void {
  storage.setItem(storageKey(origin), JSON.stringify(session))
}

export function clearRelaySession(storage: Storage = localStorage, origin = RELAY_ORIGIN): void {
  storage.removeItem(storageKey(origin))
}

export function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** A fresh RFC 7636 verifier (32 random bytes, 43 base64url characters) and
 * its S256 challenge, for the desktop app's sign-in and the web client's link
 * (src/connect/legatoLinkReturn.ts). Hashed in JavaScript: the web client is
 * usually plain http on a LAN address, which isn't a secure context, so
 * crypto.subtle isn't there (the same reason identity.ts verifies with
 * @noble). getRandomValues is there either way. */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)))
  return { verifier, challenge: base64url(sha256(new TextEncoder().encode(verifier))) }
}

function unreachable(origin: string): RelaySignInError {
  return new RelaySignInError(
    'unreachable',
    `Couldn't reach legato.fm at ${new URL(origin).host}. Check your internet connection and try again.`,
  )
}

async function relayFetch(origin: string, path: string, init: RequestInit, fetchImpl: typeof fetch): Promise<Response> {
  try {
    return await fetchImpl(`${origin}${path}`, { ...init, credentials: 'omit' })
  } catch {
    throw unreachable(origin)
  }
}

export async function fetchRelayMe(
  token: string | null,
  origin = RELAY_ORIGIN,
  fetchImpl: typeof fetch = fetch,
): Promise<RelayMe> {
  const res = await relayFetch(origin, '/auth/me', { headers: token ? { Authorization: `Bearer ${token}` } : {} }, fetchImpl)
  if (!res.ok) throw new RelaySignInError('relay', `legato.fm answered ${res.status} when checking who's signed in. Try again in a moment.`)
  return (await res.json()) as RelayMe
}

/** Swaps the loopback's one-time code, plus this attempt's verifier, for a
 * bearer token. The relay's own message explains a refused code (expired,
 * reused, issued to a different request, rate-limited). */
export async function redeemCode(
  callback: LoopbackCallback,
  verifier: string,
  origin = RELAY_ORIGIN,
  fetchImpl: typeof fetch = fetch,
): Promise<{ session: StoredRelaySession; user: RelayUser }> {
  const res = await relayFetch(
    origin,
    '/auth/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: callback.code, code_verifier: verifier, redirect_uri: callback.redirectUri }),
    },
    fetchImpl,
  )
  const body = (await res.json().catch(() => ({}))) as {
    token?: string
    expiresAt?: string
    user?: RelayUser
    message?: string
  }
  if (!res.ok || !body.token || !body.expiresAt || !body.user) {
    throw new RelaySignInError(
      'refused',
      body.message ?? `legato.fm answered ${res.status} to the sign-in code. Start sign-in again from Legato.`,
    )
  }
  return { session: { token: body.token, expiresAt: body.expiresAt }, user: body.user }
}

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>

type SignInDeps = {
  invoke: Invoke
  storage?: Storage
  origin?: string
  fetchImpl?: typeof fetch
}

/** The whole sign-in: challenge, browser, loopback, redemption, storage. */
export async function signInWithRelay(provider: RelayProvider, deps: SignInDeps): Promise<RelayUser> {
  const { invoke, storage = localStorage, origin = RELAY_ORIGIN, fetchImpl = fetch } = deps
  const { verifier, challenge } = createPkcePair()
  let callback: LoopbackCallback
  try {
    callback = await invoke<LoopbackCallback>('relay_sign_in', { relayOrigin: origin, provider, codeChallenge: challenge })
  } catch (err) {
    const { kind, message } = (err ?? {}) as { kind?: string; message?: string }
    throw new RelaySignInError(kind ?? 'unknown', message ?? String(err))
  }
  const { session, user } = await redeemCode(callback, verifier, origin, fetchImpl)
  storeRelaySession(session, storage, origin)
  return user
}

/** Ends the session on the relay and forgets it here. The local copy goes
 * even if the relay can't be reached: signing out must never fail from the
 * user's side. */
export async function relaySignOut(
  storage: Storage = localStorage,
  origin = RELAY_ORIGIN,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const session = readRelaySession(storage, origin)
  clearRelaySession(storage, origin)
  if (!session) return
  await relayFetch(origin, '/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${session.token}` } }, fetchImpl).catch(
    () => undefined,
  )
}
