import { readRelaySession } from '../auth/relaySession'
import { fetchRelayTicket, fetchWithRelayTicket, storeRelayTicket, type StoredRelayTicket } from '../auth/relayTicket'
import { readSession, storeSession, type StoredSession } from '../auth/session'
import { RELAY_ORIGIN } from '../config/relayHost'
import { verifyServerIdentity, type IdentityFailure } from './identity'
import { relayedServerId } from './serverPath'

/* Signing in to a home server with legato.fm (issue #117), in three steps,
 * in this order:
 *   1. the server proves it holds its id's key (identity.ts). Until it
 *      has, nothing goes to legato.fm on its behalf and nothing goes to it;
 *   2. legato.fm signs a ten-minute `access` token for that server id;
 *   3. the server swaps the token, once, for a session with a media ticket
 *      (POST /api/v1/auth/legato/session), which lasts a fixed 12 hours
 *      (server/src/auth/sessions.ts).
 *
 * Renewal runs the same three steps with the legato.fm session this device
 * already holds, well before the session ends (useLegatoRenewal.ts). The
 * old session isn't signed out: an <audio> URL built on its media ticket
 * keeps playing until it expires on its own.
 *
 * Through legato.fm's relay (issue #365), `origin` is the server's base
 * there, and a relay ticket for the server comes first: every step after
 * it goes through the relay with the ticket. The identity check still runs,
 * so a tunnel that answered for the wrong server would be caught. The
 * ticket comes back with the session, and renewal renews both. */

export type LegatoSignInFailure =
  | { step: 'identity'; reason: IdentityFailure }
  | { step: 'signed-out' }
  | { step: 'relay'; message: string }
  | { step: 'not-linked' }
  | { step: 'server'; status: number; reason: string | null; message: string }

export type LegatoSignInResult =
  | { ok: true; session: StoredSession; relayTicket?: StoredRelayTicket }
  | { ok: false; failure: LegatoSignInFailure }

export type LegatoSignInDeps = { fetchImpl?: typeof fetch; relayOrigin?: string; relayToken?: string | null }

export async function signInWithLegato(origin: string, serverId: string, deps: LegatoSignInDeps = {}): Promise<LegatoSignInResult> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const relayOrigin = deps.relayOrigin ?? RELAY_ORIGIN
  const relayToken = deps.relayToken === undefined ? (readRelaySession()?.token ?? null) : deps.relayToken
  if (!relayToken) return { ok: false, failure: { step: 'signed-out' } }

  let relayTicket: StoredRelayTicket | undefined
  let serverFetch = fetchImpl
  if (relayedServerId(origin, relayOrigin) === serverId) {
    const issued = await fetchRelayTicket(serverId, { fetchImpl, relayOrigin, relayToken })
    if (!issued.ok) {
      const { failure } = issued
      if (failure.kind === 'relay') return { ok: false, failure: { step: 'relay', message: failure.message } }
      return { ok: false, failure: { step: failure.kind } }
    }
    relayTicket = issued.ticket
    serverFetch = fetchWithRelayTicket(origin, relayTicket.ticket, fetchImpl)
  }

  const identity = await verifyServerIdentity(origin, serverId, serverFetch)
  if (!identity.ok) return { ok: false, failure: { step: 'identity', reason: identity.reason } }

  let tokenRes: Response
  try {
    tokenRes = await fetchImpl(`${relayOrigin}/auth/server-token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${relayToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverId, scope: 'access' }),
      credentials: 'omit',
    })
  } catch {
    return { ok: false, failure: { step: 'relay', message: `Couldn't reach legato.fm at ${new URL(relayOrigin).host}.` } }
  }
  const issued = (await tokenRes.json().catch(() => ({}))) as { token?: string; scope?: string; error?: string }
  if (tokenRes.status === 401) return { ok: false, failure: { step: 'signed-out' } }
  if (!tokenRes.ok || !issued.token) {
    return { ok: false, failure: { step: 'relay', message: issued.error ?? `legato.fm answered ${tokenRes.status}.` } }
  }
  // legato.fm signs `access` only for a server this account linked.
  if (issued.scope !== 'access') return { ok: false, failure: { step: 'not-linked' } }

  let res: Response
  try {
    res = await serverFetch(`${origin}/api/v1/auth/legato/session`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${issued.token}` },
      credentials: 'omit',
    })
  } catch {
    return { ok: false, failure: { step: 'server', status: 0, reason: null, message: `Couldn't reach ${new URL(origin).host}.` } }
  }
  const body = (await res.json().catch(() => ({}))) as {
    token?: string
    mediaTicket?: string
    expiresAt?: string
    error?: string
    reason?: string
  }
  if (!res.ok || !body.token || !body.mediaTicket || !body.expiresAt) {
    return {
      ok: false,
      failure: { step: 'server', status: res.status, reason: body.reason ?? null, message: body.error ?? `The server answered ${res.status}.` },
    }
  }
  return {
    ok: true,
    session: { token: body.token, mediaTicket: body.mediaTicket, legato: { serverId, expiresAt: body.expiresAt } },
    ...(relayTicket ? { relayTicket } : {}),
  }
}

/** The sentence the connect screen shows for a failed sign-in. */
export function describeLegatoFailure(failure: LegatoSignInFailure, serverName: string): string {
  switch (failure.step) {
    case 'identity':
      return failure.reason === 'unreachable'
        ? `Couldn't reach ${serverName} to check it.`
        : `Whatever answered as ${serverName} couldn't prove it's that server, so Legato didn't sign in to it.`
    case 'signed-out':
      return 'Your legato.fm session ended. Sign in to legato.fm again.'
    case 'relay':
      return failure.message
    case 'not-linked':
      return `${serverName} isn't linked to your legato.fm account any more. Its owner can link it again in Settings.`
    case 'server':
      return failure.message
  }
}

// A 12-hour session renews once less than this is left, so after about
// four hours. An <audio> URL on the old media ticket then has at least eight
// more hours, longer than any album; and renewing can fail for hours, with
// the internet down at home, before anyone sees a sign-in screen.
export const RENEW_WHEN_LEFT_MS = 8 * 60 * 60 * 1000
export const RENEW_RETRY_MS = 5 * 60 * 1000

export function renewDelayMs(expiresAt: string, now: number = Date.now()): number {
  return Math.max(0, Date.parse(expiresAt) - RENEW_WHEN_LEFT_MS - now)
}

/** Replaces the stored legato.fm session for `origin` with a fresh one.
 * False, with the old session left alone, when anything refuses. */
export async function renewLegatoSession(origin: string, deps: LegatoSignInDeps & { storage?: Storage } = {}): Promise<boolean> {
  const storage = deps.storage ?? localStorage
  const current = readSession(storage, origin)
  if (!current?.legato) return false
  const result = await signInWithLegato(origin, current.legato.serverId, deps)
  if (!result.ok) return false
  storeSession(result.session, storage, origin)
  if (result.relayTicket) storeRelayTicket(result.relayTicket, storage, origin)
  return true
}

/** Replaces the relay ticket for `base`, a server's base on legato.fm's
 * relay, with a fresh one. False, with the old one left alone, when
 * legato.fm refuses or can't be reached. */
export async function renewRelayTicket(
  base: string,
  deps: { fetchImpl?: typeof fetch; relayOrigin?: string; relayToken?: string | null; storage?: Storage } = {},
): Promise<boolean> {
  const serverId = relayedServerId(base, deps.relayOrigin ?? RELAY_ORIGIN)
  if (!serverId) return false
  const issued = await fetchRelayTicket(serverId, deps)
  if (!issued.ok) return false
  storeRelayTicket(issued.ticket, deps.storage ?? localStorage, base)
  return true
}
