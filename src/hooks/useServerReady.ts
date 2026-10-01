import { useEffect, useState } from 'react'
import { API_BASE } from '../config/serverHost'
import { MIN_SERVER_SCHEMA_VERSION } from '../config/serverVersion'
import { updateAction, type UpdateAction } from '../config/installChannel'

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
  /** What the last successful health check said about the server's build.
   * Null until the first one lands. */
  server: ServerVersion | null
}

export type ServerVersion = {
  /** Null on a server older than #193, which doesn't report these. */
  version: string | null
  gitSha: string | null
  schemaVersion: number | null
  /** Below MIN_SERVER_SCHEMA_VERSION, or too old to say — both mean the
   * same thing to someone reading the notice: update the server. */
  outOfDate: boolean
  /** A newer release and what to run for it (issue #110). Null when there
   * is none, the check is off, or the server is the desktop app's. */
  update: AvailableUpdate | null
}

export type AvailableUpdate = { latestVersion: string; action: UpdateAction }

// The server only reports `available` when its own daily check found a
// newer stable release than it runs (server/src/update/check.ts), so the
// client trusts that flag instead of comparing versions itself.
function readAvailableUpdate(fields: Record<string, unknown>): AvailableUpdate | null {
  const update = typeof fields.update === 'object' && fields.update !== null ? (fields.update as Record<string, unknown>) : {}
  if (update.available !== true || typeof update.latestVersion !== 'string') return null
  const channel = typeof fields.installChannel === 'string' ? fields.installChannel : null
  const releaseUrl = typeof update.releaseUrl === 'string' ? update.releaseUrl : null
  const action = updateAction(channel, releaseUrl)
  return action ? { latestVersion: update.latestVersion, action } : null
}

// Reads the version fields out of a /health body (shape documented in
// server/src/routes/health.ts). Anything missing or the wrong type counts
// as absent rather than as an error: a pre-#193 server answers
// `{"status":"ok"}` and is perfectly reachable, just out of date.
export function readServerVersion(body: unknown, minSchemaVersion: number = MIN_SERVER_SCHEMA_VERSION): ServerVersion {
  const fields = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  const version = typeof fields.version === 'string' ? fields.version : null
  const gitSha = typeof fields.gitSha === 'string' ? fields.gitSha : null
  const schemaVersion = typeof fields.schemaVersion === 'number' ? fields.schemaVersion : null
  return {
    version,
    gitSha,
    schemaVersion,
    outOfDate: schemaVersion === null || schemaVersion < minSchemaVersion,
    update: readAvailableUpdate(fields),
  }
}

function updateActionTarget(update: AvailableUpdate | null): string | undefined {
  if (!update) return undefined
  return update.action.kind === 'command' ? update.action.command : update.action.url
}

function sameServerVersion(a: ServerVersion | null, b: ServerVersion): boolean {
  return (
    a !== null &&
    a.version === b.version &&
    a.gitSha === b.gitSha &&
    a.schemaVersion === b.schemaVersion &&
    a.outOfDate === b.outOfDate &&
    a.update?.latestVersion === b.update?.latestVersion &&
    a.update?.action.kind === b.update?.action.kind &&
    updateActionTarget(a.update) === updateActionTarget(b.update)
  )
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
  const [server, setServer] = useState<ServerVersion | null>(null)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    let consecutiveFailures = 0

    const check = async () => {
      try {
        const res = await fetch(HEALTH_URL)
        if (!res.ok) throw new Error(`health check returned ${res.status}`)
        // A body that won't parse still came from a server that answered,
        // so it reads as "too old to say" rather than as an outage.
        const next = readServerVersion(await res.json().catch(() => null))
        consecutiveFailures = 0
        if (!cancelled) {
          setReady(true)
          setEverConnected(true)
          // Re-checked on every heartbeat, so a server updated and
          // restarted underneath a running client clears the notice. Keeps
          // the previous object when nothing changed, so a 3-second
          // heartbeat doesn't re-render the whole app each time.
          setServer((prev) => (sameServerVersion(prev, next) ? prev : next))
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

  return { ready, everConnected, server }
}
