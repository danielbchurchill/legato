/* The server this client was pointed at on the connect screen (issue #117),
 * kept per device in localStorage. src/config/serverHost.ts reads it when
 * the page loads, ahead of the built-in default, so choosing a server
 * reloads the page rather than making every API_BASE importer reactive.
 *
 * A page a Legato server served always talks to that server, so there
 * "connecting" means opening the other server's own web client instead. */

const STORAGE_KEY = 'legato:server-choice'

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function readServerChoice(store: Storage | null = storage()): string | null {
  const value = store?.getItem(STORAGE_KEY)
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null
  } catch {
    return null
  }
}

export function storeServerChoice(origin: string, store: Storage | null = storage()): void {
  store?.setItem(STORAGE_KEY, new URL(origin).origin)
}

export function clearServerChoice(store: Storage | null = storage()): void {
  store?.removeItem(STORAGE_KEY)
}
