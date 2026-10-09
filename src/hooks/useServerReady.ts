import { useCallback, useEffect, useRef, useState } from 'react'
import { API_BASE, SERVER_ORIGIN } from '../config/serverHost'
import { MIN_SERVER_SCHEMA_VERSION } from '../config/serverVersion'
import { updateAction, type UpdateAction } from '../config/installChannel'
import { readLastSeen, rememberSeen } from '../connect/lastSeen'
import { classifyFailure, HEALTH_TIMEOUT_MS, SERVER_BACK_EVENT, type CheckFailure } from '../connect/unreachable'

const HEALTH_URL = `${API_BASE}/health`
const STARTUP_POLL_INTERVAL_MS = 300
const HEARTBEAT_INTERVAL_MS = 3000
// A single missed heartbeat is noise (a GC pause, a slow tick) — only a
// sustained outage should flip the whole window into "server not
// reachable," per DESIGN.md's empty-state catalogue.
const HEARTBEAT_FAILURE_THRESHOLD = 3
// Two checks in a row with no answer at all are already eight seconds of
// silence, which isn't noise either.
const UNANSWERED_THRESHOLD = 2
// While it's unreachable (#119): a check a second at first, since most
// outages are a restart. After a minute it's likelier asleep or gone, and a
// check every five seconds still has it back moments after it returns.
const OUTAGE_POLL_INTERVAL_MS = 1000
const LONG_OUTAGE_POLL_INTERVAL_MS = 5000
const LONG_OUTAGE_AFTER_MS = 60_000
// How often a heartbeat writes down "last seen" for the next launch.
const REMEMBER_SEEN_EVERY_MS = 30_000

/** What's known about a server that has stopped answering (#119), for
 * src/connect/unreachable.ts to work the likely reason out from. */
export type Outage = {
  failure: CheckFailure
  /** When the server last answered, in ms: this session's last heartbeat,
   * or what this device remembered from before. Null if it never has. */
  lastSeenAt: number | null
  /** When this device's network last dropped or changed, in ms. */
  networkChangedAt: number | null
  deviceOnline: boolean
  /** When a "Try again" last ran and still found it unreachable. */
  triedAt: number | null
}

export type ServerStatus = {
  ready: boolean
  /** False until the first successful connection — lets App.tsx tell "still
   * starting up" apart from "was running, now unreachable": different
   * messages for a different problem. */
  everConnected: boolean
  /** What the last successful health check said about the server's build.
   * Null until the first one lands. */
  server: ServerVersion | null
  /** What the server calls itself (/health's name), from this session or
   * remembered from an earlier one. */
  name: string | null
  /** Set once the server has failed enough checks in a row to count as
   * unreachable, and cleared by the next one it answers. */
  outage: Outage | null
  /** Checks now rather than at the next poll. */
  retry: () => void
  /** True while a retry() check is running. */
  retrying: boolean
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

function readServerName(body: unknown): string | null {
  const name = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).name : null
  return typeof name === 'string' && name ? name : null
}

// The server is embedded and spawned by the Tauri shell (see
// src-tauri/src/server_process.rs), but its startup (npm -> tsx -> node,
// then Fastify's own listen()) isn't instant — the UI has to wait for it
// rather than assume it's already up the moment the webview loads. Keeps
// polling (at a much slower cadence) after that first connection too, so a
// server that crashes or gets killed mid-session is noticed rather than
// leaving every panel silently broken with no explanation.
//
// #119: each failed check also records how it failed, and the hook keeps
// when the server last answered and when this device's network last
// changed, so the unreachable state can say why rather than just that.
export function useServerReady(): ServerStatus {
  const [ready, setReady] = useState(false)
  const [everConnected, setEverConnected] = useState(false)
  const [server, setServer] = useState<ServerVersion | null>(null)
  const [name, setName] = useState<string | null>(() => readLastSeen(SERVER_ORIGIN)?.name ?? null)
  const [outage, setOutage] = useState<Outage | null>(null)
  const [retrying, setRetrying] = useState(false)
  const checkNow = useRef<((manual: boolean) => Promise<void>) | null>(null)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let inFlight: Promise<void> | null = null
    let consecutiveFailures = 0
    let unanswered = 0
    let down = false
    let downSince = 0
    const remembered = Date.parse(readLastSeen(SERVER_ORIGIN)?.at ?? '')
    let lastSeenAt: number | null = Number.isNaN(remembered) ? null : remembered
    let rememberedAt = 0
    let networkChangedAt: number | null = null

    const check = async (manual: boolean) => {
      const started = Date.now()
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS)
      let failure: CheckFailure | null = null
      let body: unknown = null
      try {
        const res = await fetch(HEALTH_URL, { signal: controller.signal })
        // A body that won't parse still came from a server that answered,
        // so it reads as "too old to say" rather than as an outage.
        if (res.ok) body = await res.json().catch(() => null)
        else failure = { kind: 'bad-status', status: res.status }
      } catch {
        failure = classifyFailure({ elapsedMs: Date.now() - started, timedOut: controller.signal.aborted })
      } finally {
        clearTimeout(timeout)
      }
      if (cancelled) return
      const now = Date.now()

      if (!failure) {
        const recovered = consecutiveFailures > 0
        consecutiveFailures = 0
        unanswered = 0
        down = false
        lastSeenAt = now
        const next = readServerVersion(body)
        const seenName = readServerName(body)
        if (now - rememberedAt >= REMEMBER_SEEN_EVERY_MS) {
          rememberSeen(SERVER_ORIGIN, seenName, new Date(now))
          rememberedAt = now
        }
        setReady(true)
        setEverConnected(true)
        // Re-checked on every heartbeat, so a server updated and
        // restarted underneath a running client clears the notice. Keeps
        // the previous object when nothing changed, so a 3-second
        // heartbeat doesn't re-render the whole app each time.
        setServer((prev) => (sameServerVersion(prev, next) ? prev : next))
        if (seenName) setName(seenName)
        setOutage(null)
        if (recovered) window.dispatchEvent(new Event(SERVER_BACK_EVENT))
        return
      }

      consecutiveFailures++
      if (failure.kind === 'no-answer') unanswered++
      if (!down && (consecutiveFailures >= HEARTBEAT_FAILURE_THRESHOLD || unanswered >= UNANSWERED_THRESHOLD)) {
        down = true
        downSince = now
      }
      if (!down) return
      const facts = { failure, lastSeenAt, networkChangedAt, deviceOnline: navigator.onLine }
      setReady(false)
      setOutage((prev) => ({ ...facts, triedAt: manual ? now : (prev?.triedAt ?? null) }))
    }

    const nextDelay = () => {
      if (consecutiveFailures === 0) return HEARTBEAT_INTERVAL_MS
      if (!down) return STARTUP_POLL_INTERVAL_MS
      return Date.now() - downSince < LONG_OUTAGE_AFTER_MS ? OUTAGE_POLL_INTERVAL_MS : LONG_OUTAGE_POLL_INTERVAL_MS
    }

    // One check at a time. A manual one asked for while a scheduled one is
    // running goes straight after it, so "Try again" always gets its own.
    const run = (manual = false): Promise<void> => {
      if (inFlight) return manual ? inFlight.then(() => run(true)) : inFlight
      clearTimeout(timer)
      inFlight = check(manual).finally(() => {
        inFlight = null
        if (!cancelled) timer = setTimeout(() => void run(), nextDelay())
      })
      return inFlight
    }
    checkNow.current = run

    // A network that drops or changes is half of "why", and coming back
    // is the moment to look again rather than waiting out the poll.
    const onNetworkChange = () => {
      networkChangedAt = Date.now()
      void run()
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible' && consecutiveFailures > 0) void run()
    }
    // Chromium's NetworkInformation, which also fires on a switch between
    // two networks that never goes offline in between.
    const connection = (navigator as Navigator & { connection?: EventTarget }).connection
    window.addEventListener('online', onNetworkChange)
    window.addEventListener('offline', onNetworkChange)
    connection?.addEventListener('change', onNetworkChange)
    document.addEventListener('visibilitychange', onVisible)

    void run()
    return () => {
      cancelled = true
      clearTimeout(timer)
      checkNow.current = null
      window.removeEventListener('online', onNetworkChange)
      window.removeEventListener('offline', onNetworkChange)
      connection?.removeEventListener('change', onNetworkChange)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  const retry = useCallback(() => {
    const run = checkNow.current
    if (!run) return
    setRetrying(true)
    void run(true).finally(() => setRetrying(false))
  }, [])

  return { ready, everConnected, server, name, outage, retry, retrying }
}
