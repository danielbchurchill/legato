import { RELAY_ORIGIN } from '../config/relayHost'

/* The legato.fm account's own sessions and servers (issue #115), as the
 * desktop app's Settings lists them, with its legato.fm session. Signing a
 * session out is the relay's DELETE /auth/sessions/:id; removing a server
 * is DELETE /linked-servers/:serverId, which takes the account's link to
 * it and the credential its tunnel opens with. The web client holds no
 * legato.fm session, so it lists neither until #140. */

export type AccountSession = { id: string; client: string | null; createdAt: string; lastSeenAt: string | null; current: boolean }

export type AccountServer = {
  serverId: string
  linkedAt: string
  tunnel: { connected: boolean; connectedAt?: string; lastSeenAt?: string | null }
  credentialIssuedAt: string | null
}

export class AccountRequestError extends Error {
  signedOut: boolean
  constructor(message: string, signedOut = false) {
    super(message)
    this.signedOut = signedOut
  }
}

async function call<T>(token: string, path: string, method: 'GET' | 'DELETE', origin: string, fetchImpl: typeof fetch): Promise<T> {
  let res: Response
  try {
    res = await fetchImpl(`${origin}${path}`, { method, headers: { Authorization: `Bearer ${token}` }, credentials: 'omit' })
  } catch {
    throw new AccountRequestError(`Couldn't reach legato.fm at ${new URL(origin).host}. Check your internet connection.`)
  }
  if (res.status === 401) throw new AccountRequestError('Your legato.fm session ended. Sign in again.', true)
  const body = (await res.json().catch(() => null)) as (T & { error?: string; reason?: string }) | null
  // The relay's own refusals carry a reason and a sentence to show. Anything
  // else, a 404 from a legato.fm from before #115 say, gets a sentence here.
  if (!res.ok || !body) {
    throw new AccountRequestError(body?.reason && body.error ? body.error : `legato.fm answered ${res.status}. Try again in a moment.`)
  }
  return body
}

export async function fetchAccountLists(
  token: string,
  origin: string = RELAY_ORIGIN,
  fetchImpl: typeof fetch = fetch,
): Promise<{ sessions: AccountSession[]; servers: AccountServer[] }> {
  const [{ sessions }, { servers }] = await Promise.all([
    call<{ sessions?: AccountSession[] }>(token, '/auth/sessions', 'GET', origin, fetchImpl),
    call<{ servers?: AccountServer[] }>(token, '/linked-servers', 'GET', origin, fetchImpl),
  ])
  // A legato.fm from before #115 has no session list.
  if (!Array.isArray(sessions) || !Array.isArray(servers)) {
    throw new AccountRequestError("This legato.fm can't list your account's sessions and servers yet.")
  }
  return { sessions, servers }
}

export async function signOutSession(token: string, id: string, origin: string = RELAY_ORIGIN, fetchImpl: typeof fetch = fetch) {
  await call(token, `/auth/sessions/${encodeURIComponent(id)}`, 'DELETE', origin, fetchImpl)
}

export async function removeServer(token: string, serverId: string, origin: string = RELAY_ORIGIN, fetchImpl: typeof fetch = fetch) {
  await call(token, `/linked-servers/${encodeURIComponent(serverId)}`, 'DELETE', origin, fetchImpl)
}
