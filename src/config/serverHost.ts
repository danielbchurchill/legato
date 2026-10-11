// Which server this page talks to is decided when the page loads, not when
// it's built (#116): the same dist/ ships inside the Tauri bundle and inside
// every legato-server binary, and only one of those two knows its server's
// address ahead of time.
//
// - Served by a Legato server: that server's own origin. The server marks
//   every index.html it hands out (server/src/routes/web-client.ts), so
//   this is a positive signal rather than a guess from the hostname. It
//   deliberately beats VITE_SERVER_HOST: a .env.local baked into the build
//   (the Mac's one pins the Pi) must not send a page the Pi served at
//   http://musicbox:8899/ to a hardcoded IP instead.
// - Desktop app (Tauri, dev or packaged) and plain `npm run dev`: a server
//   picked on the connect screen (#117, src/connect/serverChoice.ts), else
//   the env-derived default below, which in the desktop app is its own
//   embedded server.
// - app.legato.fm: a server picked on the connect screen, the same way,
//   once that client exists.
//
// A pick can be a route through legato.fm's relay (`<relay>/relay/<server
// id>`), so the "origin" below can carry that path. With this device's
// "never use the relay" on (#118), a route through it isn't used. Which
// path the resolved base takes goes to the connection-path store
// (connect/connectionPath.ts) as this module loads.

import { neverUseRelay, setConnectionPath } from '../connect/connectionPath'
import { readKnownServers } from '../connect/knownServers'
import { readServerChoice } from '../connect/serverChoice'
import { connectionPathOf, pathFor, relayedServerId } from '../connect/serverPath'
import { RELAY_ORIGIN } from './relayHost'

// Matches the server's own LEGATO_PORT default (server/src/config.ts).
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = '8899'

export interface PageContext {
  servedByServer: boolean
  origin: string
  /** The server that served the page, from its legato-server-id marker. */
  serverId?: string | null
}

export interface ServerEnv {
  VITE_SERVER_HOST?: string
  VITE_SERVER_PORT?: string
}

/** This device's "never use the relay" (#118), passed only while it's on. */
export interface RelayPin {
  relayOrigin: string
  /** The address this device last reached a server on at home, by id. */
  homeOrigin: (serverId: string) => string | null
}

// Dev overrides: set VITE_SERVER_HOST to reach a server bound to a
// different interface (previewing over Tailscale while Vite and the server
// both run here), VITE_SERVER_PORT alongside LEGATO_PORT to point at a
// second server on the same machine while the default port stays taken.
// `||` rather than `??` so an empty `VITE_SERVER_PORT=` line in a .env file
// falls back instead of producing `http://127.0.0.1:/api/v1`.
export function resolveServerOrigin(
  page: PageContext | null,
  env: ServerEnv,
  chosen: string | null = null,
  pin: RelayPin | null = null,
): string {
  if (page?.servedByServer) {
    // A page a server served talks to that server and no other, since it
    // runs that server's own build: at its own origin, or, picked on the
    // connect screen, at its route through legato.fm's relay (#365), unless
    // the relay is pinned off.
    const ownRoute = Boolean(chosen && page.serverId && relayedServerId(chosen) === page.serverId)
    return chosen && ownRoute && !pin ? chosen : page.origin
  }
  // A server picked on the connect screen comes ahead of the default.
  // Choosing one reloads the page, so the constants below re-resolve
  // without every importer having to become a function call.
  if (chosen) {
    const relayed = pin ? relayedServerId(chosen, pin.relayOrigin) : null
    if (relayed === null) return chosen
    // Pinned off the relay: the same server directly, at the address this
    // device last reached it on at home. Away from home that doesn't
    // answer, which is what the pin asks for. A server never reached at
    // home has no such address, and it's as though nothing were picked.
    const home = pin?.homeOrigin(relayed)
    if (home) return home
  }
  return `http://${env.VITE_SERVER_HOST || DEFAULT_HOST}:${env.VITE_SERVER_PORT || DEFAULT_PORT}`
}

function currentPage(): PageContext | null {
  if (typeof document === 'undefined') return null
  return {
    servedByServer: document.querySelector('meta[name="legato-server"]') !== null,
    origin: window.location.origin,
    serverId: document.querySelector('meta[name="legato-server-id"]')?.getAttribute('content') ?? null,
  }
}

/** True when a Legato server handed out this page. Also the condition for
 * registering the service worker (src/pwa/register.ts): a Tauri bundle or a
 * Vite dev page is never one. */
export const SERVED_BY_SERVER = currentPage()?.servedByServer ?? false
/** The id of the server that served this page (#365), when it says. */
export const SERVED_SERVER_ID = currentPage()?.serverId ?? null

// The only places a server URL is assembled. Every other file imports one
// of these rather than building its own.
const SERVER_ENV: ServerEnv = {
  VITE_SERVER_HOST: import.meta.env.VITE_SERVER_HOST,
  VITE_SERVER_PORT: import.meta.env.VITE_SERVER_PORT,
}
const RELAY_PIN: RelayPin = {
  relayOrigin: RELAY_ORIGIN,
  homeOrigin: (serverId) => readKnownServers()[serverId]?.lanOrigin ?? null,
}

export const SERVER_ORIGIN = resolveServerOrigin(currentPage(), SERVER_ENV, readServerChoice(), neverUseRelay() ? RELAY_PIN : null)
// Whether the desktop app started this server doesn't change the path's
// kind, only how it's put into words (serverPath.ts).
setConnectionPath(connectionPathOf(pathFor(SERVER_ORIGIN, false)))
/** The server's id when this client reaches it through legato.fm's relay
 * (#365); null on every other path. */
export const RELAY_SERVER_ID = relayedServerId(SERVER_ORIGIN)
/** The server this client uses when nothing was picked: in the desktop app,
 * its own embedded one. The connect screen offers to go back to it. */
export const DEFAULT_SERVER_ORIGIN = resolveServerOrigin(currentPage(), SERVER_ENV)
// Read back out of the resolved origin, not the env, so a message naming
// the server ("legato-server on musicbox is out of date") names the one
// actually being talked to. The port falls back to the scheme's default
// when the origin leaves it implicit, as a page served on :443 does.
const serverUrl = new URL(SERVER_ORIGIN)
export const SERVER_HOST = serverUrl.hostname
export const SERVER_PORT = serverUrl.port || (serverUrl.protocol === 'https:' ? '443' : '80')
export const API_BASE = `${SERVER_ORIGIN}/api/v1`
// https -> wss as well as http -> ws: a server behind a TLS reverse proxy
// serves its page over https, and a browser refuses ws:// from one.
export const WS_BASE = `${SERVER_ORIGIN.replace(/^http/, 'ws')}/api/v1`
