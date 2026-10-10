import { RELAY_ORIGIN } from '../config/relayHost'
import { relayBase, relayedServerId } from './serverPath'

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

// An origin, or a route through legato.fm's relay (#118), which keeps its
// /relay/<server id> path: there, the path is what picks the server.
function choiceFor(value: string, relayOrigin: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    const relayed = relayedServerId(url.href, relayOrigin)
    return relayed !== null ? relayBase(relayed, relayOrigin) : url.origin
  } catch {
    return null
  }
}

export function readServerChoice(store: Storage | null = storage(), relayOrigin: string = RELAY_ORIGIN): string | null {
  const value = store?.getItem(STORAGE_KEY)
  return value ? choiceFor(value, relayOrigin) : null
}

export function storeServerChoice(base: string, store: Storage | null = storage(), relayOrigin: string = RELAY_ORIGIN): void {
  const choice = choiceFor(base, relayOrigin)
  if (choice) store?.setItem(STORAGE_KEY, choice)
}

export function clearServerChoice(store: Storage | null = storage()): void {
  store?.removeItem(STORAGE_KEY)
}
