import { readRelaySession } from '../auth/relaySession'
import { API_BASE } from '../config/serverHost'
import { RELAY_ORIGIN } from '../config/relayHost'

/* Linking the server this client is signed in to with a legato.fm account
 * (issue #325), from Settings, so a server whose owner was created without a
 * claim can be linked at all, and any server can be linked again after
 * legato.fm stopped vouching for it.
 *
 * Both clients end the same way: a ten-minute `link` token for this server's
 * id goes to its POST /api/v1/auth/legato/link in the owner's session, and
 * the server does the rest (server/src/auth/legatoLink.ts): it checks
 * legato.fm's signature, reports the link signed with its own key, and stores
 * the tunnel credential legato.fm sends back. Nothing is linked on either
 * side unless that report succeeds. They differ in how they get the token:
 *   - the desktop app holds a legato.fm session of its own (relaySession.ts),
 *     so it asks /auth/server-token directly, below;
 *   - the web client can't, so it goes through legato.fm's /link page and
 *     back (legatoLinkReturn.ts). */

export type LinkedAccount = { accountId: string; email: string | null; name: string | null }

/** Fired when a link finishes outside Settings (the web client's return from
 * legato.fm), so a Settings panel that's open shows it. */
export const LINK_CHANGED_EVENT = 'legato:link-changed'

export type LinkFailure =
  | { step: 'signed-out' }
  | { step: 'cancelled' }
  | { step: 'relay'; message: string }
  | { step: 'server'; status: number; reason: string | null; message: string }

export type LinkResult = { ok: true; linked: LinkedAccount } | { ok: false; failure: LinkFailure }

export type LinkDeps = { fetchImpl?: typeof fetch; apiBase?: string }

/** Hands a link token to this server. The fetch is the app's own, which
 * carries the owner's session (src/auth/session.ts). */
export async function sendLinkToken(token: string, deps: LinkDeps = {}): Promise<LinkResult> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const apiBase = deps.apiBase ?? API_BASE
  let res: Response
  try {
    res = await fetchImpl(`${apiBase}/auth/legato/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
  } catch {
    return { ok: false, failure: { step: 'server', status: 0, reason: null, message: "Couldn't reach this server. Check it's still running, then try again." } }
  }
  const body = (await res.json().catch(() => ({}))) as { linked?: LinkedAccount; error?: string; reason?: string }
  if (!res.ok || !body.linked) {
    return {
      ok: false,
      failure: { step: 'server', status: res.status, reason: body.reason ?? null, message: body.error ?? `The server answered ${res.status}.` },
    }
  }
  return { ok: true, linked: body.linked }
}

/** The desktop app's link: its own legato.fm session asks for a `link` token
 * for this server, outright, so a server legato.fm still has on record gets
 * one too (linking again). */
export async function linkWithLegato(
  serverId: string,
  deps: LinkDeps & { relayOrigin?: string; relayToken?: string | null } = {},
): Promise<LinkResult> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const relayOrigin = deps.relayOrigin ?? RELAY_ORIGIN
  const relayToken = deps.relayToken === undefined ? (readRelaySession()?.token ?? null) : deps.relayToken
  if (!relayToken) return { ok: false, failure: { step: 'signed-out' } }

  let tokenRes: Response
  try {
    tokenRes = await fetchImpl(`${relayOrigin}/auth/server-token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${relayToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverId, scope: 'link' }),
      credentials: 'omit',
    })
  } catch {
    return { ok: false, failure: { step: 'relay', message: `Couldn't reach legato.fm at ${new URL(relayOrigin).host}.` } }
  }
  const issued = (await tokenRes.json().catch(() => ({}))) as { token?: string; scope?: string; error?: string }
  if (tokenRes.status === 401) return { ok: false, failure: { step: 'signed-out' } }
  if (!tokenRes.ok || !issued.token || issued.scope !== 'link') {
    return { ok: false, failure: { step: 'relay', message: issued.error ?? `legato.fm answered ${tokenRes.status}.` } }
  }
  return sendLinkToken(issued.token, deps)
}

/** The sentence Settings shows for a link that didn't happen. */
export function describeLinkFailure(failure: LinkFailure): string {
  switch (failure.step) {
    case 'signed-out':
      return 'Your legato.fm session ended. Sign in to legato.fm again, then link this server.'
    case 'cancelled':
      return 'You cancelled on legato.fm, so nothing was linked.'
    case 'relay':
    case 'server':
      return failure.message
  }
}
