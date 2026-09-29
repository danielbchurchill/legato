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
//   http://raspberrypi:8899/ to a hardcoded IP instead.
// - Desktop app (Tauri, dev or packaged) and plain `npm run dev`: the
//   configured endpoint, which today is still the env-derived default below.
// - app.legato.fm: a server picked on the connect screen (plan 03,
//   "Connecting a client"). Not built yet; see the seam in
//   resolveServerOrigin.

// Matches the server's own LEGATO_PORT default (server/src/config.ts).
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = '8899'

export interface PageContext {
  servedByServer: boolean
  origin: string
}

export interface ServerEnv {
  VITE_SERVER_HOST?: string
  VITE_SERVER_PORT?: string
}

// Dev overrides: set VITE_SERVER_HOST to reach a server bound to a
// different interface (previewing over Tailscale while Vite and the server
// both run here), VITE_SERVER_PORT alongside LEGATO_PORT to point at a
// second server on the same machine while the default port stays taken.
// `||` rather than `??` so an empty `VITE_SERVER_PORT=` line in a .env file
// falls back instead of producing `http://127.0.0.1:/api/v1`.
export function resolveServerOrigin(page: PageContext | null, env: ServerEnv): string {
  if (page?.servedByServer) return page.origin
  // The app.legato.fm seam: a chosen server, once the connect screen stores
  // one, is returned here ahead of the default. Choosing a server reloads
  // the page, so the constants below re-resolve without every importer
  // having to become a function call.
  return `http://${env.VITE_SERVER_HOST || DEFAULT_HOST}:${env.VITE_SERVER_PORT || DEFAULT_PORT}`
}

function currentPage(): PageContext | null {
  if (typeof document === 'undefined') return null
  return {
    servedByServer: document.querySelector('meta[name="legato-server"]') !== null,
    origin: window.location.origin,
  }
}

// The only places a server URL is assembled. Every other file imports one
// of these rather than building its own.
export const SERVER_ORIGIN = resolveServerOrigin(currentPage(), {
  VITE_SERVER_HOST: import.meta.env.VITE_SERVER_HOST,
  VITE_SERVER_PORT: import.meta.env.VITE_SERVER_PORT,
})
// Read back out of the resolved origin, not the env, so a message naming
// the server ("legato-server on raspberrypi is out of date") names the one
// actually being talked to. The port falls back to the scheme's default
// when the origin leaves it implicit, as a page served on :443 does.
const serverUrl = new URL(SERVER_ORIGIN)
export const SERVER_HOST = serverUrl.hostname
export const SERVER_PORT = serverUrl.port || (serverUrl.protocol === 'https:' ? '443' : '80')
export const API_BASE = `${SERVER_ORIGIN}/api/v1`
// https -> wss as well as http -> ws: a server behind a TLS reverse proxy
// serves its page over https, and a browser refuses ws:// from one.
export const WS_BASE = `${SERVER_ORIGIN.replace(/^http/, 'ws')}/api/v1`
