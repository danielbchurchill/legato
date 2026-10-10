import { RELAY_ORIGIN } from '../config/relayHost'
import { isLanHost, isLoopbackHost } from './address'
import type { ConnectionPath } from './connectionPath'

/* Which path a server base takes (issue #118), read off the base itself, so
 * it can't disagree with where requests actually go. serverHost.ts tells
 * connectionPath.ts's store which one as the page loads.
 *
 * ServerPath is the store's ConnectionPath with this computer split in two,
 * because the unreachable state (unreachable.ts) and the indicator say
 * different things about the desktop app's own server and anything else
 * running here. */

export type ServerPath =
  /** The desktop app's own server, which the app started (server_process.rs). */
  | 'embedded'
  /** Something else on this computer: a server run by hand, a dev setup. */
  | 'this-device'
  /** The home network, or what stands in for it (isHomeHost below): a LAN
   * address, a dotless name, or a Tailscale address. */
  | 'home'
  /** legato.fm's relay, down the server's tunnel (relay/src/routes/relay.ts). */
  | 'relay'
  /** Anything else: a domain, a public address. */
  | 'custom'

// The relay's route to one server. Everything under /relay/<server id>
// reaches that server (relay/src/routes/relay.ts), so the path is part of
// the base, not something to strip back to an origin.
const RELAY_ROUTE = /^\/relay\/([^/]+)\/?$/

/** The base that reaches `serverId` through the relay at `relayOrigin`. */
export function relayBase(serverId: string, relayOrigin: string = RELAY_ORIGIN): string {
  return `${new URL(relayOrigin).origin}/relay/${encodeURIComponent(serverId)}`
}

/** The server `base` reaches through the relay at `relayOrigin`, or null
 * when it doesn't go through it. */
export function relayedServerId(base: string, relayOrigin: string = RELAY_ORIGIN): string | null {
  try {
    const url = new URL(base)
    if (url.origin !== new URL(relayOrigin).origin || url.search || url.hash) return null
    const id = RELAY_ROUTE.exec(url.pathname)?.[1]
    return id ? decodeURIComponent(id) : null
  } catch {
    return null
  }
}

// Tailscale gives every device an address in 100.64.0.0/10.
const TAILSCALE_V4 = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/

/** True for a host the connection path counts as the home network: what
 * isLanHost says (an address that only works on the local network), plus
 * two kinds that reach a server at home from wherever this device is.
 *   - A name with no dot (`musicbox`): a LAN's own DNS, or Tailscale's
 *     MagicDNS, almost always for a server at home.
 *   - Tailscale: an address in 100.64.0.0/10, or a `*.ts.net` name. A
 *     tailnet is how people reach their own server at home, so it streams
 *     the original, as the LAN does (quality.ts).
 * Not isLanHost itself: its other caller, knownServers.ts, means an
 * address that only works at home, which a tailnet's doesn't. */
export function isHomeHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (isLanHost(h)) return true
  if (h.endsWith('.ts.net')) return true
  const tailscale = TAILSCALE_V4.exec(h)
  if (tailscale) {
    const second = Number(tailscale[1])
    return second >= 64 && second <= 127
  }
  // A dotless name. An IPv6 address has colons and no dots, so it's left out.
  return h !== '' && !h.includes('.') && !h.includes(':')
}

/** Which path `base` is. `embedded` says the desktop app started the
 * server at that base itself. The relay comes first, since a dev relay on
 * this computer is still the relay. */
export function pathFor(base: string, embedded: boolean, relayOrigin: string = RELAY_ORIGIN): ServerPath {
  if (relayedServerId(base, relayOrigin) !== null) return 'relay'
  const host = new URL(base).hostname
  if (isLoopbackHost(host)) return embedded ? 'embedded' : 'this-device'
  return isHomeHost(host) ? 'home' : 'custom'
}

/** The store's path for a ServerPath. */
export function connectionPathOf(path: ServerPath): ConnectionPath {
  return path === 'embedded' || path === 'this-device' ? 'this-computer' : path
}

/** A ServerPath for the store's path, given whether the desktop app started
 * the server this page loaded with. */
export function serverPathOf(path: ConnectionPath, embedded: boolean): ServerPath {
  if (path !== 'this-computer') return path
  return embedded ? 'embedded' : 'this-device'
}
