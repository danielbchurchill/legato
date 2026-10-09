import { useSyncExternalStore } from 'react'
import { API_BASE } from '../config/serverHost'

/* What the rest of the client hears about the server coming and going
 * (#119). useServerReady runs the health check and decides when an outage
 * starts and ends; this is how everything else finds out, so none of it has
 * to watch the health check itself. There are two signals, for two needs:
 *
 *   - SERVER_ANSWERED_EVENT, the light one: the server answered after a
 *     check that failed, or answered as a process that restarted since its
 *     last answer. It fires for a two-second restart that never becomes an
 *     outage as much as for a long one. The web player loads a stream the
 *     server cut again on it (playback/quality.ts), and it can ask whether
 *     the server failed since a given time (serverTroubleSince).
 *   - SERVER_BACK_EVENT, once a declared outage is over, or the server
 *     restarted however quickly, and only once the session has been
 *     checked: a legato.fm session can run out during a long outage, and
 *     nothing should read with it (or with its media ticket) before useAuth
 *     has renewed it. Every WebSocket is replaced then, and failed media is
 *     asked for again (useServerBackEpoch).
 *
 * The full resync, where every hook that shows server data reads it again
 * (useReconnectEpoch), costs the graph, every panel and their covers, and a
 * Pi that has just restarted meets that wave first. So it runs only when the
 * data could have moved on: the server restarted (its /health bootId
 * changed), its latest scan job isn't the one this client last heard about,
 * or a read from it failed meanwhile, leaving something on screen without
 * its data. An outage on this device's side (a phone between networks, a
 * laptop that slept) with none of those only replaces the sockets. */

/** Fired on window once the server is back and the session checked. */
export const SERVER_BACK_EVENT = 'legato:server-back'
/** Fired on window whenever the server answers after a failed check, or
 * answers as a process that restarted since its last answer. */
export const SERVER_ANSWERED_EVENT = 'legato:server-answered'

// How long the latest scan job gets to say whether it moved on. Not
// knowing counts as yes.
export const BACK_CHECK_TIMEOUT_MS = 10_000

let epoch = 0
let backs = 0
let sessionCheck: (() => Promise<void>) | null = null
let freshCheck: (() => Promise<void>) | null = null
let outage = false
let failingSince: number | null = null
let lastTroubleAt: number | null = null
let readFailed = false
// The latest scan job as this client last heard of it, as "id:status".
let latestScan: string | null = null

function emit(type: string): void {
  window.dispatchEvent(new Event(type))
}

/** For useServerReady, as a check fails. */
export function noteCheckFailed(at: number = Date.now()): void {
  failingSince ??= at
  lastTroubleAt = at
}

/** For useServerReady, as a check is answered. `restarted` says the server
 * answered as a different process from its last answer. */
export function noteCheckAnswered({ restarted }: { restarted: boolean }): void {
  const wasFailing = failingSince !== null
  failingSince = null
  if (restarted) lastTroubleAt = Date.now()
  if (wasFailing || restarted) emit(SERVER_ANSWERED_EVENT)
}

/** When the current run of failed checks began, or null while the server
 * answers. */
export function serverFailingSince(): number | null {
  return failingSince
}

/** Whether the server has failed a check, or restarted, since `at`, or is
 * failing now. */
export function serverTroubleSince(at: number): boolean {
  return failingSince !== null || (lastTroubleAt !== null && lastTroubleAt >= at)
}

/** For useServerReady: a check that starts now, not one already running. */
export function provideFreshCheck(check: () => Promise<void>): () => void {
  freshCheck = check
  return () => {
    if (freshCheck === check) freshCheck = null
  }
}

/** Checks the server now, and resolves once that check is done. */
export function checkServerNow(): Promise<void> {
  return freshCheck?.() ?? Promise.resolve()
}

/** For the fetch wrapper (auth/session.ts): a read from the server that the
 * network failed. Whatever asked for it may be showing nothing in its place,
 * so the next outage that ends reads everything again. */
export function noteReadFailed(): void {
  readFailed = true
}

/** For useScanStatus: the latest scan job, as /scan-jobs or a scan event
 * gave it. */
export function noteLatestScan(job: { id: number; status: string } | null): void {
  latestScan = job ? `${job.id}:${job.status}` : 'none'
}

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

function withTimeout<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms)
  })
  return Promise.race([work.catch(() => fallback), timeout]).finally(() => clearTimeout(timer))
}

// Whether the server's latest scan job isn't the one this client last heard
// about. Not knowing counts as yes.
async function scanMovedOn(): Promise<boolean> {
  const read = fetch(`${API_BASE}/scan-jobs`).then(async (res) => {
    if (!res.ok) return null
    const jobs = (await res.json()) as unknown
    if (!Array.isArray(jobs)) return null
    const latest = jobs[0] as { id: number; status: string } | undefined
    return latest ? `${latest.id}:${latest.status}` : 'none'
  })
  const now = await withTimeout(read, BACK_CHECK_TIMEOUT_MS, null)
  const moved = now === null || latestScan === null || now !== latestScan
  if (now !== null) latestScan = now
  return moved
}

/** For useServerReady, as an outage ends, or as the server turns out to have
 * restarted. `restarted` is true when it answers as a different process
 * from before, or doesn't say. */
export async function announceServerBack({ restarted }: { restarted: boolean }): Promise<void> {
  await sessionCheck?.().catch(() => undefined)
  const full = restarted || readFailed || (await scanMovedOn())
  outage = false
  backs += 1
  if (full) {
    readFailed = false
    epoch += 1
  }
  emit(SERVER_BACK_EVENT)
}

function subscribe(listener: () => void): () => void {
  window.addEventListener(SERVER_BACK_EVENT, listener)
  return () => window.removeEventListener(SERVER_BACK_EVENT, listener)
}

/** How many times this window has read everything from the server again. */
export function reconnectEpoch(): number {
  return epoch
}

/** The reconnect epoch, for a hook that shows server data to key its load
 * on, so it reads again after an outage that could have changed it. */
export function useReconnectEpoch(): number {
  return useSyncExternalStore(subscribe, reconnectEpoch)
}

/** How many outages this window has come back from, whatever happened in
 * them. */
export function serverBackEpoch(): number {
  return backs
}

/** The server-back epoch, for media that failed while the server was out
 * of reach (a cover) to be asked for again after every outage. */
export function useServerBackEpoch(): number {
  return useSyncExternalStore(subscribe, serverBackEpoch)
}
