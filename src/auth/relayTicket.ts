import { RELAY_ORIGIN } from '../config/relayHost'
import { readRelaySession } from './relaySession'

/* What gets this device through legato.fm's relay to one home server
 * (issue #365, relay/src/routes/relay.ts): a twelve-hour ticket legato.fm
 * signs for a server this account has linked. Every request under the
 * server's relay base carries it, as an X-Legato-Relay header from fetch()
 * (session.ts's installAuthFetch) and as a `relay` parameter in URLs that
 * can't carry a header (withMediaTicket). The relay takes it off before the
 * request reaches the server, which checks its own session as at home.
 *
 * Kept per relay base, beside the server's session but apart from it, so
 * signing out of the server leaves the way to reach it, and its sign-in
 * screen still loads. */

export type StoredRelayTicket = { ticket: string; expiresAt: string }

export const RELAY_TICKET_HEADER = 'X-Legato-Relay'
export const RELAY_TICKET_PARAM = 'relay'

const storageKey = (base: string) => `legato:relay-ticket:${base}`

export function readRelayTicket(storage: Storage, base: string): StoredRelayTicket | null {
  try {
    const parsed = JSON.parse(storage.getItem(storageKey(base)) ?? 'null') as Partial<StoredRelayTicket> | null
    return typeof parsed?.ticket === 'string' && typeof parsed.expiresAt === 'string'
      ? { ticket: parsed.ticket, expiresAt: parsed.expiresAt }
      : null
  } catch {
    return null
  }
}

export function storeRelayTicket(ticket: StoredRelayTicket, storage: Storage, base: string): void {
  storage.setItem(storageKey(base), JSON.stringify(ticket))
}

export type RelayTicketFailure = { kind: 'signed-out' } | { kind: 'not-linked' } | { kind: 'relay'; message: string }

export type RelayTicketResult = { ok: true; ticket: StoredRelayTicket } | { ok: false; failure: RelayTicketFailure }

/** Asks legato.fm for a ticket to `serverId`, with this device's legato.fm
 * session. */
export async function fetchRelayTicket(
  serverId: string,
  deps: { fetchImpl?: typeof fetch; relayOrigin?: string; relayToken?: string | null } = {},
): Promise<RelayTicketResult> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const relayOrigin = deps.relayOrigin ?? RELAY_ORIGIN
  const relayToken = deps.relayToken === undefined ? (readRelaySession()?.token ?? null) : deps.relayToken
  if (!relayToken) return { ok: false, failure: { kind: 'signed-out' } }
  let res: Response
  try {
    res = await fetchImpl(`${relayOrigin}/auth/relay-ticket`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${relayToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverId }),
      credentials: 'omit',
    })
  } catch {
    return { ok: false, failure: { kind: 'relay', message: `Couldn't reach legato.fm at ${new URL(relayOrigin).host}.` } }
  }
  const body = (await res.json().catch(() => ({}))) as { ticket?: string; expiresAt?: string; error?: string; reason?: string }
  if (res.status === 401) return { ok: false, failure: { kind: 'signed-out' } }
  if (body.reason === 'not_linked') return { ok: false, failure: { kind: 'not-linked' } }
  if (!res.ok || !body.ticket || !body.expiresAt) {
    return { ok: false, failure: { kind: 'relay', message: body.error ?? `legato.fm answered ${res.status}.` } }
  }
  return { ok: true, ticket: { ticket: body.ticket, expiresAt: body.expiresAt } }
}

/** A fetch that adds `ticket` to every request under `base`, for the calls
 * made before the page itself is pointed there (the connect screen's). */
export function fetchWithRelayTicket(base: string, ticket: string, fetchImpl: typeof fetch = fetch): typeof fetch {
  return (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!isUnderBase(url, base)) return fetchImpl(input, init)
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    headers.set(RELAY_TICKET_HEADER, ticket)
    return fetchImpl(input, { ...init, headers, credentials: 'omit' })
  }
}

/** True when `url` is `base` itself or anything under it. A base is an
 * origin, or a relay base with a path; a bare origin covers its whole
 * origin. */
export function isUnderBase(url: string | URL, base: string): boolean {
  const target = new URL(url)
  const root = new URL(base)
  if (target.origin !== root.origin) return false
  const path = root.pathname.replace(/\/$/, '')
  return path === '' || target.pathname === path || target.pathname.startsWith(`${path}/`)
}
