import { isLanHost } from './address'
import { relayedServerId } from './serverPath'

/* What this device remembers about each server it has reached (issue #117),
 * keyed by server id, in localStorage:
 *   - name: what the server calls itself (/health, or its mDNS TXT);
 *   - lanOrigin: the last LAN address it answered on, the second place the
 *     connect screen looks for it after mDNS;
 *   - lastReachedAt: when this device last reached it, for "offline since".
 *
 * legato.fm knows which servers an account linked, but not their names or
 * addresses, and this doesn't tell it: everything here stays on the device. */

const STORAGE_KEY = 'legato:known-servers'

export type KnownServer = { name: string | null; lanOrigin: string | null; lastReachedAt: string }

export type KnownServers = Record<string, KnownServer>

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function readKnownServers(store: Storage | null = storage()): KnownServers {
  try {
    const parsed = JSON.parse(store?.getItem(STORAGE_KEY) ?? '{}') as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as KnownServers) : {}
  } catch {
    return {}
  }
}

/** Records that this device just reached `serverId` at `origin`. Only a LAN
 * origin replaces the remembered LAN address. A route through legato.fm's
 * relay (#365) never does, even from a dev relay on this computer: it's
 * where "never use the relay" sends a client instead. */
export function rememberServer(
  serverId: string,
  reached: { origin: string; name?: string | null },
  now: Date = new Date(),
  store: Storage | null = storage(),
): KnownServers {
  const known = readKnownServers(store)
  const previous = known[serverId]
  const lan = isLanHost(new URL(reached.origin).hostname) && relayedServerId(reached.origin) === null
  known[serverId] = {
    name: reached.name ?? previous?.name ?? null,
    lanOrigin: lan ? reached.origin : (previous?.lanOrigin ?? null),
    lastReachedAt: now.toISOString(),
  }
  store?.setItem(STORAGE_KEY, JSON.stringify(known))
  return known
}
