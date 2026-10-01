/* Issue #128 (docs/plans/07-clients.md, "Installable web app (G16)"): what
 * the service worker is allowed to keep. The answer is the app shell and
 * nothing else — index.html, the bundled JS/CSS/fonts, the icons and the
 * manifest, i.e. exactly what `vite build` wrote to dist/.
 *
 * Never an API response, a cover or audio. Library data served from a cache
 * while the server is unreachable would be a stale library pretending to be
 * live, which is worse than an honest "can't reach legato-server". So the
 * worker only ever answers from cache for a path on the build's own file
 * list, and the list is checked against the server's API prefixes as well,
 * in case a future build ever emits something under one of them.
 *
 * Pure, with no service-worker globals, so shellPolicy.spec.ts can run it
 * in Node. worker.ts is the thin part that wires it to real events. */

/** Written into sw.js by the build (vite/shellWorker.ts). */
export type ShellManifest = {
  /** Content hash of every shell file. A new build is a new version, which
   * is what makes the browser install a fresh worker and drop the old
   * cache. */
  version: string
  /** URL paths, e.g. "/index.html", "/assets/index-abc123.js". */
  files: string[]
}

export const SHELL_CACHE_PREFIX = 'legato-shell-'

export function shellCacheName(version: string): string {
  return `${SHELL_CACHE_PREFIX}${version}`
}

/** The page's own copy of index.html, the one an offline launch falls back
 * to. Always fetched by this name, so it's the one shell path the build
 * list is guaranteed to include. */
export const SHELL_INDEX = '/index.html'

/** Added to the cached index.html when it's served because the network
 * failed. src/pwa/register.ts looks for it so App.tsx can say "can't reach
 * legato-server" instead of "starting legato-server", which in a browser is
 * never true: nothing here starts a server. */
export const OFFLINE_SHELL_MARKER = '<meta name="legato-offline-shell" content="true">'

// Same list as server/src/routes/web-client.ts's API_PREFIXES: the paths
// the client never owns.
const NEVER_CACHED_PREFIXES = ['/api', '/covers']

export function isNeverCached(pathname: string): boolean {
  return NEVER_CACHED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

/** dist/ paths that belong in the shell cache. sw.js itself is left out (the
 * browser fetches and versions it on its own), and so are source maps. */
export function selectShellFiles(distPaths: string[]): string[] {
  const files = distPaths
    .map((p) => (p.startsWith('/') ? p : `/${p}`))
    .filter((p) => p !== '/sw.js' && !p.endsWith('.map') && !isNeverCached(p))
  if (!files.includes(SHELL_INDEX)) files.push(SHELL_INDEX)
  return files.sort()
}

/** The parts of a Request the routing decision reads. */
export type RequestLike = {
  method: string
  url: string
  mode: string
  destination: string
  headers: { has(name: string): boolean }
}

/**
 * - `passthrough`: the worker doesn't answer; the browser fetches as if no
 *   worker existed. Everything not in the shell, which covers every API
 *   call, cover, stream, websocket and OAuth redirect.
 * - `navigate`: a page load. Network first, so an online launch always gets
 *   the server's current index.html, and the cached one only when the
 *   network fails.
 * - `shell`: a file from this build. Cache first; Vite names them by content
 *   hash, so a cached copy can't be stale.
 */
export type Route = 'passthrough' | 'navigate' | 'shell'

export function routeRequest(request: RequestLike, origin: string, shellFiles: ReadonlySet<string>): Route {
  if (request.method !== 'GET') return 'passthrough'
  const url = new URL(request.url)
  if (url.origin !== origin) return 'passthrough'
  // Checked before the navigation case: /api/v1/auth/google/callback is a
  // page load, and it has to reach the server.
  if (isNeverCached(url.pathname)) return 'passthrough'
  // A media ticket (?t=) marks a URL that reads library data (auth/session.ts),
  // and a range request or an <audio> destination is a stream. Neither is
  // ever on the shell list, but neither should depend on that.
  if (url.searchParams.has('t')) return 'passthrough'
  if (request.destination === 'audio' || request.destination === 'video' || request.headers.has('range')) {
    return 'passthrough'
  }
  if (request.mode === 'navigate') return 'navigate'
  if (url.search === '' && shellFiles.has(url.pathname)) return 'shell'
  return 'passthrough'
}

export function markOfflineShell(html: string): string {
  return html.includes('</head>')
    ? html.replace('</head>', `${OFFLINE_SHELL_MARKER}</head>`)
    : OFFLINE_SHELL_MARKER + html
}

/** Caches an activating worker deletes: every older shell version. Anything
 * not prefixed as ours is left alone. */
export function staleShellCaches(cacheNames: string[], currentVersion: string): string[] {
  const current = shellCacheName(currentVersion)
  return cacheNames.filter((name) => name.startsWith(SHELL_CACHE_PREFIX) && name !== current)
}
