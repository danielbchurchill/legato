import { IS_TAURI } from '../config/runtime'
import { SERVED_BY_SERVER } from '../config/serverHost'

/* Where the shell worker (worker.ts, #128) is allowed to run. All four have
 * to hold:
 *
 * - A production build. Vite dev serves modules on the fly; a worker
 *   caching them would fight HMR, and dev has no sw.js to register anyway.
 * - Not the Tauri webview. The desktop app loads its shell from the bundle,
 *   so a worker gains it nothing. On macOS it's also actively risky: WebKit
 *   keeps storage for unsigned Tauri apps in a bucket named after the raw
 *   binary ("app" for every default-named project, AGENTS.md), so a worker
 *   registered there could end up serving another project's window.
 * - Served by a Legato server (the legato-server meta tag). A worker's
 *   cache belongs to the server whose shell it holds.
 * - A browser that has service workers at all. They exist only in a secure
 *   context: https, or http on localhost. A phone opening
 *   http://musicbox:8899 has none, which is why it can't install the app
 *   either (see the PR for #128). That page says so (needsHttps below).
 */
export function shouldRegisterShellWorker(env: {
  prod: boolean
  isTauri: boolean
  servedByServer: boolean
  supported: boolean
}): boolean {
  return env.prod && !env.isTauri && env.servedByServer && env.supported
}

/* The one reason for no worker that the person can fix (#316): a page a
 * server handed out over plain http, opened from anywhere but that machine.
 * Without a worker the browser won't install the app either, so the install
 * offer (installOffer.ts) explains instead and links the page on putting
 * https in front of the server. */
export function needsHttps(env: {
  prod: boolean
  isTauri: boolean
  servedByServer: boolean
  secureContext: boolean
}): boolean {
  return env.prod && !env.isTauri && env.servedByServer && !env.secureContext
}

export const HTTPS_DOCS_URL = 'https://github.com/danielbchurchill/legato/blob/main/docs/install/https.md'

export const NEEDS_HTTPS = needsHttps({
  prod: import.meta.env.PROD,
  isTauri: IS_TAURI,
  servedByServer: SERVED_BY_SERVER,
  secureContext: typeof window === 'undefined' || window.isSecureContext,
})

export function registerShellWorker(): void {
  if (NEEDS_HTTPS) {
    console.info(`legato: not installable from ${location.origin}: browsers only run a service worker over https. See ${HTTPS_DOCS_URL}`)
    return
  }
  const register = shouldRegisterShellWorker({
    prod: import.meta.env.PROD,
    isTauri: IS_TAURI,
    servedByServer: SERVED_BY_SERVER,
    supported: 'serviceWorker' in navigator,
  })
  if (!register) return
  // After load, so precaching the shell doesn't compete with the page's own
  // first fetches for the same files. A failure only costs offline launch.
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined)
  })
}

/** True when this page is the worker's cached shell, served because the
 * network failed (shellPolicy.ts, OFFLINE_SHELL_MARKER). */
export const LAUNCHED_OFFLINE =
  typeof document !== 'undefined' && document.querySelector('meta[name="legato-offline-shell"]') !== null
