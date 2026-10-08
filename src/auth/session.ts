import { SERVER_ORIGIN } from '../config/serverHost'

/* The client half of issue #112's owner gate (server/src/auth/gate.ts).
 *
 * Sign-in hands back two credentials, and this keeps both in localStorage
 * for this server's origin:
 *   - a session token, sent as `Authorization: Bearer` on every fetch() to
 *     the server. A cookie can't do this job for every client: the Mac
 *     desktop app talking to the Pi over plain http, and the packaged
 *     tauri://localhost page talking to 127.0.0.1, are both cross-site, and
 *     without TLS a cookie can't be SameSite=None.
 *   - a media ticket, added as `?t=` to the URLs that can't carry a header
 *     at all: <img>, <audio>, the WebSocket (withMediaTicket below). The
 *     server only accepts it for reads.
 *
 * installAuthFetch() adds the header by wrapping window.fetch once at
 * startup, so the ~25 files that call fetch() stay unchanged and a new one
 * is covered without anyone remembering. */

/** `legato` marks a session opened with a legato.fm access token (#117):
 * it lasts a fixed time and is renewed through legato.fm before it ends
 * (src/connect/legatoSignIn.ts). A password session has none. */
export type LegatoSessionInfo = { serverId: string; expiresAt: string }

export type StoredSession = { token: string; mediaTicket: string; legato?: LegatoSessionInfo }

/** Fired when the server stops accepting this client's session. App.tsx
 * listens for it and falls back to the sign-in screen. */
export const AUTH_REQUIRED_EVENT = 'legato:auth-required'

// Keyed by server origin, so a client pointed at a second server (another
// worktree's port, the Pi instead of the local one) never sends one
// server's token to the other.
const storageKey = (origin: string) => `legato:session:${origin}`

function serverOrigin(): string {
  return new URL(SERVER_ORIGIN, window.location.href).origin
}

export function readSession(storage: Storage = localStorage, origin = serverOrigin()): StoredSession | null {
  try {
    const raw = storage.getItem(storageKey(origin))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StoredSession>
    if (typeof parsed.token !== 'string' || typeof parsed.mediaTicket !== 'string') return null
    const legato = parsed.legato
    return typeof legato?.serverId === 'string' && typeof legato.expiresAt === 'string'
      ? { token: parsed.token, mediaTicket: parsed.mediaTicket, legato: { serverId: legato.serverId, expiresAt: legato.expiresAt } }
      : { token: parsed.token, mediaTicket: parsed.mediaTicket }
  } catch {
    return null
  }
}

export function storeSession(session: StoredSession, storage: Storage = localStorage, origin = serverOrigin()): void {
  storage.setItem(storageKey(origin), JSON.stringify(session))
}

export function clearSession(storage: Storage = localStorage, origin = serverOrigin()): void {
  storage.removeItem(storageKey(origin))
}

/** `url` with this session's media ticket appended, or unchanged when
 * signed out (the request then fails with 401 like any other). */
export function withMediaTicket(url: string, session: StoredSession | null = readSession()): string {
  if (!session) return url
  return `${url}${url.includes('?') ? '&' : '?'}t=${encodeURIComponent(session.mediaTicket)}`
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

type AuthFetchDeps = {
  baseFetch: typeof fetch
  origin: string
  storage: Storage
  onAuthRequired: () => void
  pageUrl: string
}

// Split out from installAuthFetch so session.spec.ts can drive it without a
// browser window.
export function createAuthFetch({ baseFetch, origin, storage, onAuthRequired, pageUrl }: AuthFetchDeps): typeof fetch {
  return async (input, init) => {
    const url = new URL(requestUrl(input), pageUrl)
    if (url.origin !== origin) return baseFetch(input, init)

    const session = readSession(storage, origin)
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    if (session && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${session.token}`)
    // 'include' so the cookie path works too: the Google/GitHub popup only
    // leaves a cookie behind, and the dev page on 127.0.0.1:5173 is a
    // different origin from the server on :8899 (same site, though, so a
    // SameSite=Lax cookie is still sent).
    const res = await baseFetch(input, { ...init, headers, credentials: init?.credentials ?? 'include' })

    // A 401 from /auth/* is a wrong password or setup code, which the form
    // that sent it shows itself. Anywhere else it means this session is no
    // longer accepted. A legato.fm session stays put for useAuth to renew
    // through legato.fm first (#117); it clears it if that fails.
    if (res.status === 401 && !url.pathname.includes('/auth/')) {
      if (!session?.legato) clearSession(storage, origin)
      onAuthRequired()
    }
    return res
  }
}

let installed = false

export function installAuthFetch(): void {
  if (installed) return
  installed = true
  window.fetch = createAuthFetch({
    baseFetch: window.fetch.bind(window),
    origin: serverOrigin(),
    storage: localStorage,
    onAuthRequired: () => window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT)),
    pageUrl: window.location.href,
  })
}
