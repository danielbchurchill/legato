import { RELAY_SERVER_ID, SERVER_ORIGIN } from '../config/serverHost'
import { noteReadFailed } from '../connect/reconnect'
import { isUnderBase, readRelayTicket, RELAY_TICKET_HEADER, RELAY_TICKET_PARAM } from './relayTicket'

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
 * is covered without anyone remembering.
 *
 * Through legato.fm's relay (issue #365) the server is a base with a path,
 * https://auth.legato.fm/relay/<id>, not an origin, and both helpers add
 * the relay ticket (relayTicket.ts) beside the server's own credential. */

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
// server's token to the other. Every server shares the relay's origin, so
// through the relay the key is the server's base there.
const storageKey = (origin: string) => `legato:session:${origin}`

function serverOrigin(): string {
  return RELAY_SERVER_ID ? SERVER_ORIGIN : new URL(SERVER_ORIGIN, window.location.href).origin
}

function currentRelayTicket(): string | null {
  return RELAY_SERVER_ID ? (readRelayTicket(localStorage, SERVER_ORIGIN)?.ticket ?? null) : null
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
 * signed out (the request then fails with 401 like any other). Through the
 * relay, its ticket too. */
export function withMediaTicket(
  url: string,
  session: StoredSession | null = readSession(),
  relayTicket: string | null = currentRelayTicket(),
): string {
  const params: string[] = []
  if (session) params.push(`t=${encodeURIComponent(session.mediaTicket)}`)
  if (relayTicket) params.push(`${RELAY_TICKET_PARAM}=${encodeURIComponent(relayTicket)}`)
  if (params.length === 0) return url
  return `${url}${url.includes('?') ? '&' : '?'}${params.join('&')}`
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
  /** A request the network failed: not one that was aborted. */
  onNetworkError?: (url: URL) => void
  pageUrl: string
  /** Set when `origin` is a server's base on legato.fm's relay: the ticket
   * every request under it carries. */
  relayTicket?: () => string | null
}

// Split out from installAuthFetch so session.spec.ts can drive it without a
// browser window.
export function createAuthFetch({
  baseFetch,
  origin,
  storage,
  onAuthRequired,
  onNetworkError,
  pageUrl,
  relayTicket,
}: AuthFetchDeps): typeof fetch {
  return async (input, init) => {
    const url = new URL(requestUrl(input), pageUrl)
    if (!isUnderBase(url, origin)) return baseFetch(input, init)

    const session = readSession(storage, origin)
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    if (session && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${session.token}`)
    const ticket = relayTicket?.()
    if (ticket && !headers.has(RELAY_TICKET_HEADER)) headers.set(RELAY_TICKET_HEADER, ticket)
    // 'include' so the cookie path works too: the Google/GitHub popup only
    // leaves a cookie behind, and the dev page on 127.0.0.1:5173 is a
    // different origin from the server on :8899 (same site, though, so a
    // SameSite=Lax cookie is still sent). Never through the relay: no
    // cookie of legato.fm's belongs on a request from here, and its CORS
    // allows no credentialed request (relay/src/routes/relay.ts).
    const credentials = relayTicket ? 'omit' : (init?.credentials ?? 'include')
    const res = await baseFetch(input, { ...init, headers, credentials }).catch((err: unknown) => {
      if (!(err instanceof DOMException && err.name === 'AbortError')) onNetworkError?.(url)
      throw err
    })

    // A 401 from /auth/* is a wrong password or setup code, which the form
    // that sent it shows itself. Anywhere else it means this session is no
    // longer accepted. A legato.fm session stays put for useAuth to renew
    // through legato.fm first (#117); it clears it if that fails. So does
    // any session when it's the relay that refused, not the server: only
    // the relay ticket ran out, and useAuth renews that.
    if (res.status === 401 && !url.pathname.includes('/auth/')) {
      const relayRefused = Boolean(relayTicket) && (await refusedByRelay(res))
      if (!session?.legato && !relayRefused) clearSession(storage, origin)
      onAuthRequired()
    }
    return res
  }
}

// The relay's own refusal says so (relay/src/routes/relay.ts).
export const RELAY_REFUSED_REASON = 'relay_signed_out'

export async function refusedByRelay(res: Response): Promise<boolean> {
  const body = (await res
    .clone()
    .json()
    .catch(() => null)) as { reason?: unknown } | null
  return body?.reason === RELAY_REFUSED_REASON
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
    // #119: whatever asked may now show nothing in its place, so the next
    // outage that ends has everything read again (connect/reconnect.ts).
    // Not the health check's own failures: those are what an outage is
    // made of, and nothing shows what they would have read.
    onNetworkError: (url) => {
      if (!url.pathname.endsWith('/health')) noteReadFailed()
    },
    pageUrl: window.location.href,
    relayTicket: RELAY_SERVER_ID ? currentRelayTicket : undefined,
  })
}
