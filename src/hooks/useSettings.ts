import { useCallback, useEffect, useRef, useState } from 'react'
import { API_BASE as API } from '../config/serverHost'
import { useReconnectEpoch } from '../connect/reconnect'
import { useWsEvent } from './useWs'

// The generic key-value store server/src/routes/settings.ts exposes —
// every value is a plain string (the enrichment toggle is '1'/'0' rather
// than a real boolean, same idiom SQLite's own INTEGER-as-boolean columns
// use elsewhere in this codebase) so this hook stays a thin, typed-nowhere
// wrapper rather than a schema for a store that has none.
export type Settings = Record<string, string>

/* #467: a change saved from one device reaches the others while they're
 * open. The server says so with `settings:changed` (server/src/routes/
 * settings.ts), carrying the settings the change wrote and who wrote them,
 * so a device skips the echo of its own writes: applied late, an echo
 * would pull a slider back under a finger still dragging it. This id names
 * this page's writes; it isn't a secret, and plain HTTP on a LAN has no
 * crypto.randomUUID. */
export const SETTINGS_CHANGED_EVENT = 'settings:changed'
export const SETTINGS_CLIENT_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`

type SettingsChange = { changed?: unknown; from?: unknown }

type UseSettingsOptions = {
  /** Which settings another device's change applies to here as it's made.
   * The rest arrive with the next load, after a reload or an outage. */
  live?: (key: string) => boolean
}

export function useSettings({ live }: UseSettingsOptions = {}) {
  const [settings, setSettings] = useState<Settings>({})
  const [loaded, setLoaded] = useState(false)
  // The last value the server actually confirmed — distinct from `settings`,
  // which may currently hold an unconfirmed optimistic guess. Rollback needs
  // this, not `settings`, or it rolls back onto someone else's optimism.
  const confirmedSettingsRef = useRef<Settings>({})
  // Strictly increasing per-call sequence number. Lets a call recognize,
  // once its own request resolves, whether it's still the most recent one.
  const requestIdRef = useRef(0)
  // Whether a load has ever come back.
  const everLoadedRef = useRef(false)
  // Other devices' changes, numbered as they arrive, and kept while a load
  // or a save is out: the server may have answered either from before the
  // change, so what it answers gets the change laid back over it.
  const remoteSeqRef = useRef(0)
  const remoteLogRef = useRef<{ seq: number; changes: Settings }[]>([])
  const inFlightRef = useRef(0)
  const liveRef = useRef(live)
  liveRef.current = live

  const started = useCallback(() => {
    inFlightRef.current++
    return remoteSeqRef.current
  }, [])
  const finished = useCallback(() => {
    if (--inFlightRef.current === 0) remoteLogRef.current = []
  }, [])
  // What other devices changed since `seq`, less the settings in `own`: for
  // those, this device's write and theirs crossed, and the server's answer
  // to this one is the nearest thing to knowing which landed last.
  const remoteSince = useCallback((seq: number, own: Settings = {}): Settings => {
    const changes: Settings = {}
    for (const entry of remoteLogRef.current) {
      if (entry.seq <= seq) continue
      for (const [key, value] of Object.entries(entry.changes)) if (!(key in own)) changes[key] = value
    }
    return changes
  }, [])

  useWsEvent(live ? [SETTINGS_CHANGED_EVENT] : [], (payload) => {
    const { changed, from } = (payload ?? {}) as SettingsChange
    if (from === SETTINGS_CLIENT_ID || changed == null || typeof changed !== 'object') return
    const accept = liveRef.current
    const applied: Settings = {}
    for (const [key, value] of Object.entries(changed)) {
      if (typeof value === 'string' && accept?.(key)) applied[key] = value
    }
    if (Object.keys(applied).length === 0) return
    const seq = ++remoteSeqRef.current
    if (inFlightRef.current > 0) remoteLogRef.current.push({ seq, changes: applied })
    confirmedSettingsRef.current = { ...confirmedSettingsRef.current, ...applied }
    setSettings((current) => ({ ...current, ...applied }))
  })

  // Loaded once, and again after every outage (#119), when another device
  // may have changed them. A change made here since the load began wins
  // over what the load brings back. The first load always counts as
  // loaded, though: the stage waits for it (App.tsx), and a click on the
  // map/library switch before a slow first load came back would otherwise
  // leave it blank. What it brought fills in under that change.
  const reconnects = useReconnectEpoch()
  useEffect(() => {
    const requestId = requestIdRef.current
    const seq = started()
    fetch(`${API}/settings`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`settings returned ${r.status}`))))
      .then((loaded: Settings) => {
        const s = { ...loaded, ...remoteSince(seq) }
        const first = !everLoadedRef.current
        everLoadedRef.current = true
        if (requestIdRef.current === requestId) {
          confirmedSettingsRef.current = s
          setSettings(s)
        } else if (first) {
          // A change made before it came back may have been confirmed
          // already, and is newer than this.
          confirmedSettingsRef.current = { ...s, ...confirmedSettingsRef.current }
          setSettings((current) => ({ ...s, ...current }))
        }
        setLoaded(true)
      })
      .catch(() => setLoaded(true))
      .finally(finished)
  }, [reconnects, started, finished, remoteSince])

  // Issue #81: every settings-backed toggle/button in the app (repeat mode,
  // view switch, map presets, the MusicMapSettings/LegatoSettings panels)
  // funnels through this one function, and it used to wait on the full PUT
  // round trip before `settings` ever changed. On localhost that's
  // imperceptible, but against a real network hop (the standalone server on
  // another machine, same as this app's own real-world macOS setup) it's
  // long enough that a second impatient click reads the still-stale
  // `settings` a caller closed over — e.g. onCycleRepeat computing
  // NEXT_REPEAT_MODE[repeatMode] from the same pre-update mode twice in a
  // row — so the button reads as needing several clicks to do one thing.
  //
  // The first fix for that (apply the partial immediately, persist in the
  // background) introduced a burst-of-clicks regression of its own: every
  // call raced every other one for the right to call setSettings(updated)
  // once its own PUT resolved, with no regard for which call was actually
  // most recent. Three quick clicks showed the optimistic +3 value, then
  // visibly stepped BACKWARD to +1 as the first click's response landed,
  // then +2, then +3 — and if the network delivered those three responses
  // out of order, the button could settle on whichever response happened
  // to arrive last rather than the one the user actually clicked last. The
  // catch block had a matching bug: it rolled back to `previous`, the state
  // captured at the moment its OWN request started, which silently threw
  // away any optimistic updates from later clicks that had landed since.
  //
  // requestIdRef fixes both: only the response (success or failure) whose
  // id still matches the ref when it resolves is allowed to touch state —
  // every older, superseded response is simply dropped, so state only ever
  // moves forward toward the most recently requested value, never backward
  // toward a stale one. A failed newest request rolls back to
  // confirmedSettingsRef — real last-known server state — rather than to
  // whatever some other in-flight call's unconfirmed optimism happened to
  // leave in `settings`. res.ok is checked explicitly too: an error
  // response body has no reason to look like a Settings object, and used
  // to get stored as if it were one.
  const updateSettings = useCallback(
    async (partial: Settings) => {
      const requestId = ++requestIdRef.current
      setSettings((current) => ({ ...current, ...partial }))
      const seq = started()
      try {
        const res = await fetch(`${API}/settings?from=${SETTINGS_CLIENT_ID}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(partial),
        })
        if (!res.ok) {
          throw new Error(`Failed to update settings: ${res.status}`)
        }
        const updated = { ...((await res.json()) as Settings), ...remoteSince(seq, partial) }
        if (requestIdRef.current === requestId) {
          confirmedSettingsRef.current = updated
          setSettings(updated)
        }
      } catch {
        if (requestIdRef.current === requestId) {
          setSettings(confirmedSettingsRef.current)
        }
      } finally {
        finished()
      }
    },
    [started, finished, remoteSince],
  )

  return { settings, loaded, updateSettings }
}
