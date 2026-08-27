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

  const updateSettings = useCallback(async (partial: Settings) => {
    const res = await fetch(`${API}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(partial),
    })
    const updated = (await res.json()) as Settings
    setSettings(updated)
  }, [])

  return { settings, loaded, updateSettings }
}
