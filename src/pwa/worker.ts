import {
  SHELL_INDEX,
  markOfflineShell,
  routeRequest,
  shellCacheName,
  staleShellCaches,
  type ShellManifest,
} from './shellPolicy'

/* The service worker itself (#128). Built to /sw.js by vite/shellWorker.ts,
 * which also prepends the shell manifest, and type-checked against the
 * WebWorker lib by tsconfig.sw.json rather than the app's DOM one. All the
 * decisions live in shellPolicy.ts; this file only connects them to events. */

const sw = self as unknown as ServiceWorkerGlobalScope & { __LEGATO_SHELL_MANIFEST__?: ShellManifest }

// Missing only if the build step that writes it didn't run. An empty list
// still installs, caches nothing, and lets every request through.
const manifest: ShellManifest = sw.__LEGATO_SHELL_MANIFEST__ ?? { version: 'unversioned', files: [] }
const cacheName = shellCacheName(manifest.version)
const shellFiles = new Set(manifest.files)

sw.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(cacheName)
      // 'reload' skips the HTTP cache, so the copy stored is this deploy's
      // and not one the browser kept from the last.
      await cache.addAll(manifest.files.map((file) => new Request(file, { cache: 'reload' })))
      // A new deploy takes over at once, not after every tab and the
      // installed app have been closed (on a phone that can be days).
      await sw.skipWaiting()
    })(),
  )
})

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await Promise.all(staleShellCaches(await caches.keys(), manifest.version).map((name) => caches.delete(name)))
      await sw.clients.claim()
    })(),
  )
})

async function offlineShell(): Promise<Response> {
  const cached = await caches.match(SHELL_INDEX, { cacheName })
  if (!cached) return Response.error()
  return new Response(markOfflineShell(await cached.text()), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}

sw.addEventListener('fetch', (event) => {
  const route = routeRequest(event.request, sw.location.origin, shellFiles)
  if (route === 'passthrough') return

  if (route === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => offlineShell()))
    return
  }

  event.respondWith(
    caches.match(event.request, { cacheName }).then((hit) => hit ?? fetch(event.request)),
  )
})
