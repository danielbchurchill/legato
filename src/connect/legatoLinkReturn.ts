import { createPkcePair } from '../auth/relaySession'
import { sendLinkToken, type LinkDeps, type LinkResult } from './legatoLink'

/* The web client's link to legato.fm (issue #325). A page a home server
 * serves, often plain http on a LAN address, can't hold a legato.fm session:
 * auth.legato.fm's cookie would be third-party here, and Safari blocks that.
 * So the link is a top-level round trip through legato.fm's own /link page
 * (relay/src/routes/link-page.ts), in this tab, with PKCE (RFC 7636):
 *   1. the verifier stays in this tab's sessionStorage, and its S256
 *      challenge goes to legato.fm with this server's id and this page's
 *      address;
 *   2. there, signed in, the owner presses link, and legato.fm sends this
 *      page back a one-time code in the fragment, which no server and no
 *      Referer header ever sees. It's taken out of the address bar before
 *      the app draws (takeLinkReturn, from main.tsx);
 *   3. once this page has the owner's session, the code and the verifier
 *      buy a `link` token at legato.fm's /link/redeem, and the token goes to
 *      the server exactly as the desktop app's does (legatoLink.ts).
 * A copied code is useless without the verifier, and legato.fm takes it
 * once, from this page's origin, within five minutes. The token itself only
 * ever travels in request and response bodies.
 *
 * The code and verifier stay until legato.fm's answer settles it: a token,
 * or the code refused (used, expired, unknown). A rate limit or a network
 * failure leaves them, so the owner can try again from here. */

const PENDING_KEY = 'legato:link-pending'
// What legato.fm puts in the fragment: the code, or `cancelled` when the
// owner cancelled there. Matches relay/src/link-codes.ts.
const CODE_PARAM = 'legato_link'
const CANCELLED = 'cancelled'

type Pending = { issuer: string; verifier: string; code?: string }

function readPending(storage: Storage): Pending | null {
  try {
    const parsed = JSON.parse(storage.getItem(PENDING_KEY) ?? 'null') as Partial<Pending> | null
    if (typeof parsed?.issuer !== 'string' || typeof parsed.verifier !== 'string') return null
    return { issuer: parsed.issuer, verifier: parsed.verifier, ...(typeof parsed.code === 'string' ? { code: parsed.code } : {}) }
  } catch {
    return null
  }
}

type Here = Pick<Location, 'origin' | 'pathname' | 'hash' | 'search'>

/** Leaves for legato.fm's /link page. The issuer is the legato.fm this server
 * trusts (GET /auth/status's legato.issuer), not one baked into the build. */
export function startBrowserLink(
  serverId: string,
  issuer: string,
  deps: { storage?: Storage; location?: Here & Pick<Location, 'assign'> } = {},
): void {
  const storage = deps.storage ?? sessionStorage
  const location = deps.location ?? window.location
  const { verifier, challenge } = createPkcePair()
  storage.setItem(PENDING_KEY, JSON.stringify({ issuer, verifier }))
  const query = new URLSearchParams({ server: serverId, return_to: `${location.origin}${location.pathname}`, code_challenge: challenge })
  location.assign(`${issuer}/link?${query}`)
}

/** Takes legato.fm's code out of the address bar, before anything renders,
 * and keeps it with this tab's verifier until the owner is signed in. A code
 * this tab didn't ask for is dropped: there's no verifier to spend it with. */
export function takeLinkReturn(
  deps: { location?: Here; history?: Pick<History, 'replaceState' | 'state'>; storage?: Storage } = {},
): void {
  const location = deps.location ?? window.location
  const history = deps.history ?? window.history
  const storage = deps.storage ?? sessionStorage
  const fragment = new URLSearchParams(location.hash.replace(/^#/, ''))
  const code = fragment.get(CODE_PARAM)
  if (code === null) return
  history.replaceState(history.state, '', `${location.pathname}${location.search}`)
  const pending = readPending(storage)
  if (pending) storage.setItem(PENDING_KEY, JSON.stringify({ ...pending, code }))
}

/** True once legato.fm has sent back a code this tab hasn't settled. */
export function hasLinkReturn(storage: Storage = sessionStorage): boolean {
  return Boolean(readPending(storage)?.code)
}

/** Spends the code legato.fm sent back, then links the server with the
 * token it buys. Null when there's nothing to finish, and a `cancelled`
 * failure when the owner cancelled on legato.fm. After any other failure,
 * hasLinkReturn says whether the same code can be tried again.
 *
 * One at a time: the code stays until legato.fm answers, so a second call
 * meanwhile (React runs an effect twice in development) would spend it
 * again and read "already used". That call gets null. */
let finishing: Promise<LinkResult | null> | null = null

export function finishBrowserLink(deps: LinkDeps & { storage?: Storage } = {}): Promise<LinkResult | null> {
  if (finishing) return Promise.resolve(null)
  finishing = finishOnce(deps).finally(() => {
    finishing = null
  })
  return finishing
}

async function finishOnce(deps: LinkDeps & { storage?: Storage }): Promise<LinkResult | null> {
  const storage = deps.storage ?? sessionStorage
  const fetchImpl = deps.fetchImpl ?? fetch
  const pending = readPending(storage)
  if (!pending?.code) return null
  if (pending.code === CANCELLED) {
    storage.removeItem(PENDING_KEY)
    return { ok: false, failure: { step: 'cancelled' } }
  }

  let res: Response
  try {
    res = await fetchImpl(`${pending.issuer}/link/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: pending.code, code_verifier: pending.verifier }),
      credentials: 'omit',
    })
  } catch {
    return { ok: false, failure: { step: 'relay', message: `Couldn't reach legato.fm at ${new URL(pending.issuer).host}.` } }
  }
  // legato.fm spends a code on its first try, right or wrong. So once it
  // has answered with a token, or refused the code, the code is gone.
  // Anything else (too many tries from this address, legato.fm down) leaves
  // it to try again.
  if (res.ok || res.status === 400) storage.removeItem(PENDING_KEY)
  const issued = (await res.json().catch(() => ({}))) as { token?: string; scope?: string; error?: string }
  if (!res.ok || !issued.token || issued.scope !== 'link') {
    return { ok: false, failure: { step: 'relay', message: issued.error ?? `legato.fm answered ${res.status}.` } }
  }
  return sendLinkToken(issued.token, deps)
}
