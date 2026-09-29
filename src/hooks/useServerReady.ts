import { useEffect, useState } from 'react'
import { API_BASE } from '../config/serverHost'

const HEALTH_URL = `${API_BASE}/health`
const STARTUP_POLL_INTERVAL_MS = 300
const HEARTBEAT_INTERVAL_MS = 3000
// A single missed heartbeat is noise (a GC pause, a slow tick) — only a
// sustained outage should flip the whole window into "server not
// reachable," per DESIGN.md's empty-state catalogue.
const HEARTBEAT_FAILURE_THRESHOLD = 3

export type ServerStatus = {
  ready: boolean
  /** False until the first successful connection — lets App.tsx tell "still
   * starting up" apart from "was running, now unreachable": different
   * messages for a different problem. */
  everConnected: boolean
}

// The server is embedded and spawned by the Tauri shell (see
// src-tauri/src/server_process.rs), but its startup (npm -> tsx -> node,
// then Fastify's own listen()) isn't instant — the UI has to wait for it
// rather than assume it's already up the moment the webview loads. Keeps
// polling (at a much slower cadence) after that first connection too, so a
// server that crashes or gets killed mid-session is noticed rather than
// leaving every panel silently broken with no explanation.
export function useServerReady(): ServerStatus {
  const [ready, setReady] = useState(false)
  const [everConnected, setEverConnected] = useState(false)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    let consecutiveFailures = 0

    const check = async () => {
      try {
        const res = await fetch(HEALTH_URL)
        if (!res.ok) throw new Error(`health check returned ${res.status}`)
        consecutiveFailures = 0
        if (!cancelled) {
          setReady(true)
          setEverConnected(true)
        }
      } catch {
        consecutiveFailures++
        if (!cancelled && consecutiveFailures >= HEARTBEAT_FAILURE_THRESHOLD) setReady(false)
      } finally {
        if (!cancelled) {
          const interval = consecutiveFailures === 0 ? HEARTBEAT_INTERVAL_MS : STARTUP_POLL_INTERVAL_MS
          timer = setTimeout(check, interval)
        }
      }
    }

    check()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [])

  return { ready, everConnected }
}
