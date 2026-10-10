import { useSyncExternalStore } from 'react'

/* How this client reaches its server right now (issue #118, plan 03): this
 * computer, the home network, legato.fm's relay, or a custom address. The
 * rail's connection indicator draws it, the stream quality ladder starts
 * from it (playback/quality.ts), and the unreachable state reasons from it
 * (App.tsx).
 *
 * Only serverHost.ts and the connect flow set it. serverHost.ts does as the
 * page loads, from the base it resolved (serverPath.ts's pathFor), before
 * anything reads it. A connect flow that moves to another route to the
 * same server without reloading the page says so here, and everything
 * reading it follows.
 *
 * Also this device's "never use the relay", the one path a person can rule
 * out. serverHost.ts refuses a relay base while it's set. */

export type ConnectionPath = 'this-computer' | 'home' | 'relay' | 'custom'

let path: ConnectionPath = 'this-computer'
const listeners = new Set<() => void>()

export function getConnectionPath(): ConnectionPath {
  return path
}

export function subscribeConnectionPath(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function setConnectionPath(next: ConnectionPath): void {
  if (next === path) return
  path = next
  for (const listener of listeners) listener()
}

export function useConnectionPath(): ConnectionPath {
  return useSyncExternalStore(subscribeConnectionPath, getConnectionPath)
}

// Per device, like the stream quality (quality.ts): a phone that leaves
// home and a desktop that never does want different answers.
export const NEVER_RELAY_KEY = 'legato:never-relay'

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function neverUseRelay(store: Storage | null = storage()): boolean {
  return store?.getItem(NEVER_RELAY_KEY) === 'true'
}

/** Turns this device's "never use the relay" on or off. Turned on while
 * connected through the relay, it reloads: serverHost.ts resolves the base
 * as the page loads, and won't resolve a route through the relay then. */
export function setNeverUseRelay(
  on: boolean,
  { store = storage(), reload = () => window.location.reload() }: { store?: Storage | null; reload?: () => void } = {},
): void {
  if (on) store?.setItem(NEVER_RELAY_KEY, 'true')
  else store?.removeItem(NEVER_RELAY_KEY)
  if (on && path === 'relay') reload()
}
