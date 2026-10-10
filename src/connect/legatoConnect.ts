import { createPkcePair, storeRelaySession, type RelayUser } from '../auth/relaySession'
import { RELAY_ORIGIN } from '../config/relayHost'
import { API_BASE } from '../config/serverHost'

/* The web client's legato.fm sign-in (issue #365), so a page a home server
 * serves can reach that server through legato.fm's relay when it's away from
 * home. It can't hold legato.fm's session cookie (third-party here), and
 * legato.fm won't take its word for which server it belongs to, so:
 *   1. its own server signs a statement vouching for this page's origin and
 *      this attempt's PKCE challenge (POST /api/v1/auth/legato/web-client,
 *      the owner only, from this page only);
 *   2. the page goes to legato.fm's /connect with it, top-level, in this tab
 *      (relay/src/routes/connect-page.ts), where the signed-in owner presses
 *      continue, and comes back with a one-time code in the fragment, which
 *      no server and no Referer ever sees;
 *   3. the code and the verifier buy a session for that one server
 *      (POST /connect/redeem), kept like the desktop app's (relaySession.ts).
 * The same round trip as #325's link (legatoLinkReturn.ts), and the same
 * rules for the code: it's taken out of the address bar before the app
 * draws, and kept with this tab's verifier until legato.fm settles it. */

const PENDING_KEY = 'legato:connect-pending'
// legato.fm sent back a code or a cancellation this tab has no verifier for.
const LOST_KEY = 'legato:connect-lost'
// Matches relay/src/web-sessions.ts.
const CODE_PARAM = 'legato_connect'
const CANCELLED = 'cancelled'

type Pending = { relayOrigin: string; verifier: string; code?: string }

function readPending(storage: Storage): Pending | null {
  try {
    const parsed = JSON.parse(storage.getItem(PENDING_KEY) ?? 'null') as Partial<Pending> | null
    if (typeof parsed?.relayOrigin !== 'string' || typeof parsed.verifier !== 'string') return null
    return { relayOrigin: parsed.relayOrigin, verifier: parsed.verifier, ...(typeof parsed.code === 'string' ? { code: parsed.code } : {}) }
  } catch {
    return null
  }
}

type Here = Pick<Location, 'origin' | 'pathname' | 'hash' | 'search'>

type Statement = { serverId: string; origin: string; codeChallenge: string; expiresAt: number; name: string; signature: string }

/** Has this page's server vouch for it, then leaves for legato.fm. A
 * sentence saying why, when the server won't. */
export async function startBrowserConnect(
  deps: {
    fetchImpl?: typeof fetch
    apiBase?: string
    relayOrigin?: string
    storage?: Storage
    location?: Here & Pick<Location, 'assign'>
  } = {},
): Promise<string | null> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const relayOrigin = deps.relayOrigin ?? RELAY_ORIGIN
  const storage = deps.storage ?? sessionStorage
  const location = deps.location ?? window.location
  noteConnectFailure(null)
  const { verifier, challenge } = createPkcePair()
  let res: Response
  try {
    res = await fetchImpl(`${deps.apiBase ?? API_BASE}/auth/legato/web-client`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ codeChallenge: challenge }),
    })
  } catch {
    return "Couldn't reach this server. Check it's still running, then try again."
  }
  const body = (await res.json().catch(() => ({}))) as Partial<Statement> & { error?: string }
  if (!res.ok || typeof body.signature !== 'string') return body.error ?? `The server answered ${res.status}.`
  const statement = body as Statement
  storage.removeItem(LOST_KEY)
  storage.setItem(PENDING_KEY, JSON.stringify({ relayOrigin, verifier }))
  const query = new URLSearchParams({
    server: statement.serverId,
    return_to: `${location.origin}${location.pathname}`,
    code_challenge: statement.codeChallenge,
    name: statement.name,
    expires: String(statement.expiresAt),
    signature: statement.signature,
  })
  location.assign(`${relayOrigin}/connect?${query}`)
  return null
}

/** Takes legato.fm's code out of the address bar before anything renders,
 * and keeps it with this tab's verifier. A code with no verifier can't be
 * spent, so it's dropped, and the sign-in is reported as lost. */
export function takeConnectReturn(
  deps: { location?: Here; history?: Pick<History, 'replaceState' | 'state'>; storage?: Storage } = {},
): void {
  const location = deps.location ?? window.location
  const history = deps.history ?? window.history
  const storage = deps.storage ?? sessionStorage
  const code = new URLSearchParams(location.hash.replace(/^#/, '')).get(CODE_PARAM)
  if (code === null) return
  history.replaceState(history.state, '', `${location.pathname}${location.search}`)
  const pending = readPending(storage)
  if (pending) storage.setItem(PENDING_KEY, JSON.stringify({ ...pending, code }))
  else storage.setItem(LOST_KEY, '1')
}

export function hasConnectReturn(storage: Storage = sessionStorage): boolean {
  return Boolean(readPending(storage)?.code) || storage.getItem(LOST_KEY) !== null
}

export type ConnectFailure = { step: 'cancelled' } | { step: 'lost' } | { step: 'relay'; message: string }

export type ConnectResult = { ok: true; user: RelayUser } | { ok: false; failure: ConnectFailure }

export function describeConnectFailure(failure: ConnectFailure): string {
  switch (failure.step) {
    case 'cancelled':
      return 'You cancelled on legato.fm, so this page isn’t signed in.'
    case 'lost':
      return 'The sign-in came back to a different tab or window than the one it started in, so it couldn’t finish. Start it again here.'
    case 'relay':
      return failure.message
  }
}

/** Spends the code legato.fm sent back, and keeps the session it buys. Null
 * when there's nothing to finish. One at a time: a second call while the
 * first is out gets null rather than spending the code twice. */
let finishing: Promise<ConnectResult | null> | null = null

export function finishBrowserConnect(
  deps: { fetchImpl?: typeof fetch; storage?: Storage; sessions?: Storage } = {},
): Promise<ConnectResult | null> {
  if (finishing) return Promise.resolve(null)
  finishing = finishOnce(deps).finally(() => {
    finishing = null
  })
  return finishing
}

async function finishOnce(deps: { fetchImpl?: typeof fetch; storage?: Storage; sessions?: Storage }): Promise<ConnectResult | null> {
  const storage = deps.storage ?? sessionStorage
  const fetchImpl = deps.fetchImpl ?? fetch
  if (storage.getItem(LOST_KEY) !== null) {
    storage.removeItem(LOST_KEY)
    return { ok: false, failure: { step: 'lost' } }
  }
  const pending = readPending(storage)
  if (!pending?.code) return null
  if (pending.code === CANCELLED) {
    storage.removeItem(PENDING_KEY)
    return { ok: false, failure: { step: 'cancelled' } }
  }
  let res: Response
  try {
    res = await fetchImpl(`${pending.relayOrigin}/connect/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: pending.code, code_verifier: pending.verifier }),
      credentials: 'omit',
    })
  } catch {
    return { ok: false, failure: { step: 'relay', message: `Couldn't reach legato.fm at ${new URL(pending.relayOrigin).host}.` } }
  }
  // Spent on its first try, right or wrong: once legato.fm has answered with
  // a session or refused the code, it's gone.
  if (res.ok || res.status === 400) storage.removeItem(PENDING_KEY)
  const body = (await res.json().catch(() => ({}))) as { token?: string; expiresAt?: string; user?: RelayUser; error?: string }
  if (!res.ok || !body.token || !body.expiresAt || !body.user) {
    return { ok: false, failure: { step: 'relay', message: body.error ?? `legato.fm answered ${res.status}.` } }
  }
  storeRelaySession({ token: body.token, expiresAt: body.expiresAt }, deps.sessions ?? localStorage, pending.relayOrigin)
  return { ok: true, user: body.user }
}

// The last sign-in's failure, for the connect screen to show when it opens
// (useLegatoConnectReturn opens it once legato.fm has answered).
let lastFailure: string | null = null

export function noteConnectFailure(message: string | null): void {
  lastFailure = message
}

export function connectFailure(): string | null {
  return lastFailure
}
