import { useCallback, useEffect, useRef, useState } from 'react'
import { API_BASE, SERVER_ORIGIN } from '../config/serverHost'
import { MIN_SERVER_SCHEMA_VERSION } from '../config/serverVersion'
import { updateAction, type UpdateAction } from '../config/installChannel'
import { readLastSeen, rememberSeen } from '../connect/lastSeen'
import { announceServerBack, noteCheckAnswered, noteCheckFailed, noteOutage, provideFreshCheck } from '../connect/reconnect'
import { classifyFailure, HEALTH_TIMEOUT_MS, outageFailure, type CheckFailure } from '../connect/unreachable'

const HEALTH_URL = `${API_BASE}/health`
const HEARTBEAT_INTERVAL_MS = 3000

// When failed checks become an outage (#119). A slow answer isn't one: a Pi
// whose event loop a recompute blocks answers /health after nine seconds,
// and a phone's round trip spikes for seconds over DERP or cellular. So what
// counts is how long the server has gone without answering, timed from the
// first check it failed, and how long depends on how the checks failed:
//   - turned away, or answered by something that isn't Legato: a definite
//     answer, so three seconds. A restart without a migration is back within
//     a second or two, as is a phone roaming between access points, and
//     neither should flash the state. A server that has stopped is still
//     named promptly.
//   - no answer at all: a host asleep or gone, or one that's only slow, so
//     fifteen seconds, which outlasts the slowest working answers above with
//     room. Checks time out after HEALTH_TIMEOUT_MS, so a host that's really
//     asleep is named in about twenty.
const DOWN_AFTER_REFUSED_MS = 3000
const DOWN_AFTER_SILENCE_MS = 15_000

// How often it checks:
//   - while the server answers, the heartbeat above;
//   - after a check fails, every 300 ms until it's an outage or answers, so
//     a restart is back on screen the moment it's up;
//   - during an outage, every second at first, since most outages are a
//     restart. After a minute it's likelier asleep or gone, and every five
//     seconds still has it back moments after it returns.
const SUSPECT_POLL_INTERVAL_MS = 300
const OUTAGE_POLL_INTERVAL_MS = 1000
const LONG_OUTAGE_POLL_INTERVAL_MS = 5000
const LONG_OUTAGE_AFTER_MS = 60_000

// Before the first answer: every 300 ms for the first minute, however the
// checks fail. The desktop app's own server is usually up in a second or
// two, and every moment a poll waits is a moment the window still says
// "starting". A migration that backs up a big library first can take
// minutes, so after the first minute it eases off: every second, then every
// five once it has waited five minutes.
const STARTUP_POLL_INTERVAL_MS = 300
const STARTUP_WINDOW_MS = 60_000
const LONG_STARTUP_AFTER_MS = 5 * 60_000
// How often a heartbeat writes down "last seen" for the next launch.
const REMEMBER_SEEN_EVERY_MS = 30_000

// A page that's frozen (a phone's tab in the background, a laptop asleep)
// runs no timers, so a check in flight then can't time out, and fails or
// answers only once the page runs again, minutes or hours after it began.
// That says nothing about the server. A check that took this much longer
// than its own timeout spanned a freeze, as did a poll that came this late,
// and the time without an answer is measured again from there.
const FROZEN_CHECK_MS = HEALTH_TIMEOUT_MS + 5000
const FROZEN_POLL_LATE_MS = 5000

/** What's known about a server that has stopped answering (#119), for
 * src/connect/unreachable.ts to work the likely reason out from. */
export type Outage = {
  /** When it became an outage, in ms. The words are worked out as of then,
   * so they hold still for as long as it lasts. */
  since: number
  /** How it has failed over the outage so far (unreachable.ts's
   * outageFailure), not just the last check. */
  failure: CheckFailure
  /** When the server last answered, in ms: this session's last heartbeat,
   * or what this device remembered from before. Null if it never has. */
  lastSeenAt: number | null
  /** When this device's network last changed, in ms: back online after
   * being offline, or a different kind of network. */
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

function sameOutage(a: Outage | null, b: Outage): boolean {
  return (
    a !== null &&
    a.since === b.since &&
    a.failure.kind === b.failure.kind &&
    (a.failure.kind === 'bad-status' ? b.failure.kind === 'bad-status' && a.failure.status === b.failure.status : true) &&
    a.lastSeenAt === b.lastSeenAt &&
    a.networkChangedAt === b.networkChangedAt &&
    a.deviceOnline === b.deviceOnline &&
    a.triedAt === b.triedAt
  )
}

function readServerName(body: unknown): string | null {
  const name = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).name : null
  return typeof name === 'string' && name ? name : null
}

// Which process answered (/health's bootId): a server that restarted, however
// quickly, answers with a new one. Null from a server too old to say.
function readBootId(body: unknown): string | null {
  const bootId = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).bootId : null
  return typeof bootId === 'string' && bootId ? bootId : null
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
    const mountedAt = Date.now()
    let everAnswered = false
    // When the current run of failures began, and how the server has failed
    // over that run (outageFailure). Null while it answers. The run begins
    // with the first failed check that started after the last answer and
    // after the page last woke from a freeze (resumedAt).
    let failingSince: number | null = null
    let resumedAt = 0
    // The bootId of the server's last answer.
    let bootId: string | null = null
    let failedHow: CheckFailure | null = null
    // What the state was last given, so a check that changes nothing sets
    // nothing: during an outage that's a check a second, and each set would
    // re-render the whole app under the state for no change.
    let shown: Outage | null = null
    let triedAt: number | null = null
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
        if (!res.ok) failure = { kind: 'bad-status', status: res.status }
        else {
          // Only a body that arrived whole is an answer. One cut off on the
          // way, by the timeout or the server going, fails the check like
          // any other (the catch below): read as an empty answer it would
          // mark the server out of date, and the app would remount around
          // that and lose the queue. A 200 that isn't JSON isn't Legato's
          // health. A pre-#193 server's {"status":"ok"} still parses, and
          // reads as out of date because it is.
          try {
            body = await res.json()
          } catch (err) {
            if (!(err instanceof SyntaxError)) throw err
            failure = { kind: 'bad-status', status: res.status }
          }
        }
      } catch {
        failure = classifyFailure({ elapsedMs: Date.now() - started, timedOut: controller.signal.aborted })
      } finally {
        clearTimeout(timeout)
      }
      if (cancelled) return
      const now = Date.now()

      if (!failure) {
        // Back after an outage, not after a check or two that failed: those
        // are a hiccup, and nothing needs to load again for one. A restart
        // is something to load again for, outage or not: the scan it
        // interrupted is paused now, and its events went nowhere. After an
        // outage, a server too old to say which process it is might have
        // restarted.
        const recovered = down
        const seenBoot = readBootId(body)
        const newProcess = bootId !== null && seenBoot !== null && seenBoot !== bootId
        const mayHaveRestarted = newProcess || seenBoot === null || bootId === null
        bootId = seenBoot
        failingSince = null
        failedHow = null
        shown = null
        triedAt = null
        down = false
        everAnswered = true
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
        noteCheckAnswered({ restarted: newProcess })
        if (recovered || newProcess) void announceServerBack({ restarted: recovered ? mayHaveRestarted : true })
        return
      }

      if (now - started > FROZEN_CHECK_MS) {
        pageResumed(now)
        return
      }
      noteCheckFailed(now)
      failingSince ??= Math.max(started, resumedAt)
      failedHow = outageFailure(failedHow, failure)
      const limit = failedHow.kind === 'no-answer' ? DOWN_AFTER_SILENCE_MS : DOWN_AFTER_REFUSED_MS
      if (!down && now - failingSince >= limit) {
        down = true
        downSince = now
        noteOutage()
        setReady(false)
      }
      if (!down) return
      if (manual) triedAt = now
      const next: Outage = { since: downSince, failure: failedHow, lastSeenAt, networkChangedAt, deviceOnline: navigator.onLine, triedAt }
      if (sameOutage(shown, next)) return
      shown = next
      setOutage(next)
    }

    // The page ran again after a freeze. Failures from before it don't count
    // towards an outage, and it looks again soon.
    let recheckSoon = false
    const pageResumed = (now: number) => {
      resumedAt = now
      recheckSoon = true
      if (!down) {
        failingSince = null
        failedHow = null
      }
    }

    const nextDelay = () => {
      const now = Date.now()
      if (recheckSoon) {
        recheckSoon = false
        return SUSPECT_POLL_INTERVAL_MS
      }
      if (!everAnswered) {
        const waited = now - mountedAt
        if (waited < STARTUP_WINDOW_MS) return STARTUP_POLL_INTERVAL_MS
        return waited < LONG_STARTUP_AFTER_MS ? OUTAGE_POLL_INTERVAL_MS : LONG_OUTAGE_POLL_INTERVAL_MS
      }
      if (failingSince === null) return HEARTBEAT_INTERVAL_MS
      if (!down) return SUSPECT_POLL_INTERVAL_MS
      return now - downSince < LONG_OUTAGE_AFTER_MS ? OUTAGE_POLL_INTERVAL_MS : LONG_OUTAGE_POLL_INTERVAL_MS
    }

    // One check at a time. A manual one asked for while a scheduled one is
    // running goes straight after it, so "Try again" always gets its own.
    const run = (manual = false): Promise<void> => {
      if (inFlight) return manual ? inFlight.then(() => run(true)) : inFlight
      clearTimeout(timer)
      inFlight = check(manual).finally(() => {
        inFlight = null
        if (cancelled) return
        const delay = nextDelay()
        const due = Date.now() + delay
        timer = setTimeout(() => {
          if (Date.now() - due > FROZEN_POLL_LATE_MS) pageResumed(Date.now())
          void run()
        }, delay)
      })
      return inFlight
    }
    checkNow.current = run
    // A check of its own for the web player, which asks whether the server
    // failed since a stream began (playback/quality.ts).
    const withdrawFreshCheck = provideFreshCheck(() => (inFlight ? inFlight.then(() => run()) : run()))

    // A network that drops or changes is half of "why", and coming back is
    // the moment to look again rather than waiting out the poll. Only a real
    // change counts: back online after being offline, or a different kind of
    // network.
    let offline = !navigator.onLine
    const onOffline = () => {
      offline = true
      void run()
    }
    const onOnline = () => {
      if (!offline) return
      offline = false
      networkChangedAt = Date.now()
      void run()
    }
    // Chromium's NetworkInformation, for a switch between two networks that
    // never goes offline in between (Wi-Fi to cellular). It also fires
    // whenever its round-trip and bandwidth estimates move, which is all the
    // time and no change at all, so only a new type counts. Desktop Chromium
    // reports no type, so there it's online after offline or nothing.
    const connection = (navigator as Navigator & { connection?: EventTarget & { type?: string } }).connection
    let connectionType = connection?.type
    const onConnectionChange = () => {
      if (connection?.type === connectionType) return
      connectionType = connection?.type
      networkChangedAt = Date.now()
      void run()
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible' && failingSince !== null) void run()
    }
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    connection?.addEventListener('change', onConnectionChange)
    document.addEventListener('visibilitychange', onVisible)

    void run()
    return () => {
      cancelled = true
      clearTimeout(timer)
      checkNow.current = null
      withdrawFreshCheck()
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      connection?.removeEventListener('change', onConnectionChange)
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
