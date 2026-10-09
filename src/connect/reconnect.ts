import { useSyncExternalStore } from 'react'

/* What the rest of the client hears about the server coming back after an
 * outage (#119). useServerReady decides when an outage starts and ends; this
 * is how everything else that reads from the server finds out, so none of it
 * has to watch the health check itself.
 *
 * The server's back once it answers after a declared outage, not after one
 * failed check, and only once the session has been checked: a legato.fm
 * session can run out during a long outage, and nothing should read with it
 * (or with its media ticket) before useAuth has renewed it. Then the
 * reconnect epoch goes up by one, and SERVER_BACK_EVENT fires on window for
 * code outside React. */

/** Fired on window once the server is back and the session checked. */
export const SERVER_BACK_EVENT = 'legato:server-back'

/** SERVER_BACK_EVENT's detail: when the server last answered before the
 * outage, in ms. A failure after that came while it was out of reach. */
export type ServerBackDetail = { since: number }

let epoch = 0
let sessionCheck: (() => Promise<void>) | null = null
let outage = false

/** For useServerReady, as it declares an outage. */
export function noteOutage(): void {
  outage = true
}

/** True from a declared outage until the server's back and the session
 * checked. Something that would load again on the browser's `online` waits
 * for SERVER_BACK_EVENT instead while this holds. */
export function inOutage(): boolean {
  return outage
}

/** For useAuth: the check to run before anything reads from a server that's
 * back. Returns a function that withdraws it. */
export function provideSessionCheck(check: () => Promise<void>): () => void {
  sessionCheck = check
  return () => {
    if (sessionCheck === check) sessionCheck = null
  }
}

/** For useServerReady, as an outage ends. `since` is when the server last
 * answered before it. */
export async function announceServerBack(since: number): Promise<void> {
  await sessionCheck?.().catch(() => undefined)
  outage = false
  epoch += 1
  window.dispatchEvent(new CustomEvent<ServerBackDetail>(SERVER_BACK_EVENT, { detail: { since } }))
}

function subscribe(listener: () => void): () => void {
  window.addEventListener(SERVER_BACK_EVENT, listener)
  return () => window.removeEventListener(SERVER_BACK_EVENT, listener)
}

/** How many outages this window has come back from. */
export function reconnectEpoch(): number {
  return epoch
}

/** The reconnect epoch, for a hook that reads from the server to key its
 * load on, so it reads once more after every outage. */
export function useReconnectEpoch(): number {
  return useSyncExternalStore(subscribe, reconnectEpoch)
}
