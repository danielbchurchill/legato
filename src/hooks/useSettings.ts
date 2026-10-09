import { useCallback, useEffect, useRef, useState } from 'react'
import { API_BASE as API } from '../config/serverHost'
import { useReconnectEpoch } from '../connect/reconnect'

// The generic key-value store server/src/routes/settings.ts exposes —
// every value is a plain string (the enrichment toggle is '1'/'0' rather
// than a real boolean, same idiom SQLite's own INTEGER-as-boolean columns
// use elsewhere in this codebase) so this hook stays a thin, typed-nowhere
// wrapper rather than a schema for a store that has none.
export type Settings = Record<string, string>

export function useSettings() {
  const [settings, setSettings] = useState<Settings>({})
  const [loaded, setLoaded] = useState(false)
  // The last value the server actually confirmed — distinct from `settings`,
  // which may currently hold an unconfirmed optimistic guess. Rollback needs
  // this, not `settings`, or it rolls back onto someone else's optimism.
  const confirmedSettingsRef = useRef<Settings>({})
  // Strictly increasing per-call sequence number. Lets a call recognize,
  // once its own request resolves, whether it's still the most recent one.
  const requestIdRef = useRef(0)

  // Loaded once, and again after every outage (#119), when another device
  // may have changed them. A change made here since the load began wins
  // over what the load brings back.
  const reconnects = useReconnectEpoch()
  useEffect(() => {
    const requestId = requestIdRef.current
    fetch(`${API}/settings`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`settings returned ${r.status}`))))
      .then((s: Settings) => {
        if (requestIdRef.current !== requestId) return
        confirmedSettingsRef.current = s
        setSettings(s)
        setLoaded(true)
      })
      .catch(() => setLoaded(true))
  }, [reconnects])

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
  const updateSettings = useCallback(async (partial: Settings) => {
    const requestId = ++requestIdRef.current
    setSettings((current) => ({ ...current, ...partial }))
    try {
      const res = await fetch(`${API}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(partial),
      })
      if (!res.ok) {
        throw new Error(`Failed to update settings: ${res.status}`)
      }
      const updated = (await res.json()) as Settings
      if (requestIdRef.current === requestId) {
        confirmedSettingsRef.current = updated
        setSettings(updated)
      }
    } catch {
      if (requestIdRef.current === requestId) {
        setSettings(confirmedSettingsRef.current)
      }
    }
  }, [])

  return { settings, loaded, updateSettings }
}
