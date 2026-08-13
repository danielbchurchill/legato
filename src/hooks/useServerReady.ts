import { useEffect, useState } from 'react'

const HEALTH_URL = 'http://127.0.0.1:8899/api/v1/health'
const POLL_INTERVAL_MS = 300

// The server is embedded and spawned by the Tauri shell (see
// src-tauri/src/server_process.rs), but its startup (npm -> tsx -> node,
// then Fastify's own listen()) isn't instant — the UI has to wait for it
// rather than assume it's already up the moment the webview loads.
export function useServerReady(): boolean {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>

    const poll = async () => {
      try {
        const res = await fetch(HEALTH_URL)
        if (res.ok) {
          if (!cancelled) setReady(true)
          return
        }
      } catch {
        // server not listening yet — keep polling
      }
      if (!cancelled) timer = setTimeout(poll, POLL_INTERVAL_MS)
    }

    poll()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [])

  return ready
}
