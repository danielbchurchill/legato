import { useCallback, useEffect, useState } from 'react'
import { SERVER_HOST } from '../config/serverHost'

const API = `http://${SERVER_HOST}:8899/api/v1`

// The generic key-value store server/src/routes/settings.ts exposes —
// every value is a plain string (the enrichment toggle is '1'/'0' rather
// than a real boolean, same idiom SQLite's own INTEGER-as-boolean columns
// use elsewhere in this codebase) so this hook stays a thin, typed-nowhere
// wrapper rather than a schema for a store that has none.
export type Settings = Record<string, string>

export function useSettings() {
  const [settings, setSettings] = useState<Settings>({})
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    fetch(`${API}/settings`)
      .then((r) => r.json())
      .then((s: Settings) => {
        setSettings(s)
        setLoaded(true)
      })
      .catch(() => setLoaded(true))
  }, [])

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
  // Applying the partial immediately (same optimistic-then-persist idiom
  // NodeTitleBlock's favourite heart already uses) fixes both: the caller's
  // next render sees the new value right away, and the control itself
  // reflects the change without waiting on the network. Rolled back to
  // whatever `settings` held before if the request fails.
  const updateSettings = useCallback(async (partial: Settings) => {
    let previous: Settings = {}
    setSettings((current) => {
      previous = current
      return { ...current, ...partial }
    })
    try {
      const res = await fetch(`${API}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(partial),
      })
      const updated = (await res.json()) as Settings
      setSettings(updated)
    } catch {
      setSettings(previous)
    }
  }, [])

  return { settings, loaded, updateSettings }
}
