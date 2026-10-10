/* When this device last reached each server, and what the server called
 * itself then (issue #119), keyed by origin in localStorage. The heartbeat
 * writes it (useServerReady.ts), so a client that opens to a server already
 * gone can still say since when, and name it.
 *
 * Keyed by origin rather than by server id like knownServers.ts: the
 * origin is all a client knows about a server that isn't answering. It
 * stays on the device, like knownServers.ts. */

const STORAGE_KEY = 'legato:last-seen'

export type LastSeen = { at: string; name: string | null }

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function readAll(store: Storage | null): Record<string, LastSeen> {
  try {
    const parsed = JSON.parse(store?.getItem(STORAGE_KEY) ?? '{}') as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, LastSeen>) : {}
  } catch {
    return {}
  }
}

export function readLastSeen(origin: string, store: Storage | null = storage()): LastSeen | null {
  const seen = readAll(store)[origin]
  return seen && typeof seen.at === 'string' ? { at: seen.at, name: typeof seen.name === 'string' ? seen.name : null } : null
}

/** When a server was last seen, as a time today or a date and time before
 * that: the connect screen's "offline since …" and the unreachable state's
 * "stopped answering at …". */
export function formatSince(at: string | number, now: number = Date.now()): string {
  const date = new Date(at)
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  if (date.toDateString() === new Date(now).toDateString()) return time
  return `${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${time}`
}

/** Records that `origin` answered just now. A name it didn't give keeps the
 * one remembered from before. */
export function rememberSeen(origin: string, name: string | null, now: Date = new Date(), store: Storage | null = storage()): void {
  const all = readAll(store)
  all[origin] = { at: now.toISOString(), name: name ?? all[origin]?.name ?? null }
  try {
    store?.setItem(STORAGE_KEY, JSON.stringify(all))
  } catch {
    // Storage full or blocked: the state just won't know since when.
  }
}
