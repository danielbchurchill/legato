import { useSyncExternalStore } from 'react'

/* Away from home (#412): whether the server says this device is at home or
 * away from it, the trips that answer makes, and the rule for the notice
 * that tells a device on Tailscale it's still streaming originals.
 *
 * The answer comes from the server, which asks its own tailscaled how it
 * reaches this device, and pushes it down the WebSocket when it changes
 * (server/src/tailscale/whereabouts.ts). A page can't tell Wi-Fi from mobile
 * data on an iPhone, so it never works this out itself.
 *
 * The rule, as DESIGN.md has it ("Away from home"): a trip starts at the
 * first `away` answer for this device and ends at the next `home` answer;
 * `unknown` neither starts nor ends one. The notice shows the first time in
 * a trip that all of these hold: Away from home is `tell me`; the track is
 * streaming at original quality; the playing file is at least 320 kbps; the
 * page is visible; and nothing it waits for is going on. Either choice in it
 * sets Away from home, so it never shows again until the person sets `tell
 * me` back in Settings. Closing it without choosing changes nothing and
 * snoozes it until the first trip that starts on a later day. If the device
 * is seen at home while it's open, it closes by itself and counts as never
 * shown.
 *
 * All of it is kept on this device, like the stream quality: the pick under
 * `legato:away-quality`, the snooze under `legato:away-notice-snoozed`, and
 * the trip itself under `legato:away-trip`, so a launch while the device is
 * still away doesn't show the notice again. */

export type Whereabouts = 'home' | 'away' | 'unknown'

/** Away from home, in Settings: tell me (the notice), standard while away,
 * or the same quality as at home. */
export type AwayQuality = 'tell' | 'standard' | 'same'

export const AWAY_QUALITY_OPTIONS = [
  { value: 'tell', label: 'tell me' },
  { value: 'standard', label: 'standard · 160 kbps' },
  { value: 'same', label: 'same as home' },
] as const satisfies readonly { value: AwayQuality; label: string }[]

export const AWAY_QUALITY_KEY = 'legato:away-quality'
export const AWAY_SNOOZE_KEY = 'legato:away-notice-snoozed'
export const AWAY_TRIP_KEY = 'legato:away-trip'

/** The WebSocket event the server's answer comes as. */
export const WHEREABOUTS_EVENT = 'device:where'

/** One trip away from home: the local date it started on, and whether the
 * notice has shown in it. */
export type Trip = { startedOn: string; shown: boolean }

/** The local calendar date, YYYY-MM-DD. */
export function localDate(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** A trip after the answer `where`, and what's left of the snooze: `away`
 * starts one if none is under way, and a trip starting on a later date than
 * the snooze clears it; `home` ends it; `unknown` changes nothing. */
export function afterAnswer(
  where: Whereabouts,
  { trip, snoozedOn }: { trip: Trip | null; snoozedOn: string | null },
  today: string,
): { trip: Trip | null; snoozedOn: string | null } {
  if (where === 'home') return { trip: null, snoozedOn }
  if (where === 'unknown' || trip) return { trip, snoozedOn }
  return { trip: { startedOn: today, shown: false }, snoozedOn: snoozedOn != null && today > snoozedOn ? null : snoozedOn }
}

/** Whether the notice shows now, by the rule above. */
export function noticeDue(input: {
  quality: AwayQuality
  trip: Trip | null
  snoozedOn: string | null
  /** The playing track asked for the original. */
  streamingOriginal: boolean
  /** The playing file's average bitrate, if the scan read one. */
  kbps: number | null
  visible: boolean
  /** Something the notice waits for is going on: a text field in use, a
   * press held, a menu open. */
  interrupted: boolean
}): boolean {
  const { quality, trip, snoozedOn, streamingOriginal, kbps, visible, interrupted } = input
  if (quality !== 'tell' || !trip || trip.shown) return false
  // Snoozed until the first trip that starts on a later day.
  if (snoozedOn != null && trip.startedOn <= snoozedOn) return false
  return streamingOriginal && kbps != null && kbps >= 320 && visible && !interrupted
}

/* ---- The store ---------------------------------------------------------- */

export type AwayState = {
  /** The server's latest answer for this device. */
  where: Whereabouts
  quality: AwayQuality
  trip: Trip | null
  snoozedOn: string | null
  /** The notice is showing. */
  open: boolean
}

function defaultStorage(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage
}

function readQuality(storage: Storage | null): AwayQuality {
  const stored = storage?.getItem(AWAY_QUALITY_KEY)
  return AWAY_QUALITY_OPTIONS.find((option) => option.value === stored)?.value ?? 'tell'
}

function readTrip(storage: Storage | null): Trip | null {
  try {
    const value = JSON.parse(storage?.getItem(AWAY_TRIP_KEY) ?? 'null') as Partial<Trip> | null
    if (value && typeof value.startedOn === 'string' && typeof value.shown === 'boolean')
      return { startedOn: value.startedOn, shown: value.shown }
  } catch {
    // Not a trip.
  }
  return null
}

function readSnooze(storage: Storage | null): string | null {
  const stored = storage?.getItem(AWAY_SNOOZE_KEY) ?? null
  return stored && /^\d{4}-\d{2}-\d{2}$/.test(stored) ? stored : null
}

function readStored(storage: Storage | null): Omit<AwayState, 'where' | 'open'> {
  return { quality: readQuality(storage), trip: readTrip(storage), snoozedOn: readSnooze(storage) }
}

/** The answer, the pick, the trip and the notice, for one device. A class
 * so a spec can make one over its own storage and clock; the app uses
 * `awayFromHome` below. */
export class AwayStore {
  private state: AwayState
  private readonly listeners = new Set<() => void>()
  private readonly storage: Storage | null
  private readonly today: () => string

  constructor({ storage = defaultStorage(), today = () => localDate() }: { storage?: Storage | null; today?: () => string } = {}) {
    this.storage = storage
    this.today = today
    this.state = { where: 'unknown', open: false, ...readStored(storage) }
  }

  snapshot = (): AwayState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The server's answer for this device. */
  setWhereabouts = (where: Whereabouts): void => {
    const next = afterAnswer(where, this.state, this.today())
    // Seen at home while it's open: it closes by itself, as if never shown.
    const open = this.state.open && where !== 'home'
    this.change({ where, ...next, open })
  }

  /** The notice is showing: it counts as shown for this trip. */
  showNotice = (): void => {
    if (!this.state.trip || this.state.open) return
    this.change({ open: true, trip: { ...this.state.trip, shown: true } })
  }

  /** Closed without choosing: nothing changes, and it's snoozed until the
   * first trip that starts on a later day. */
  dismissNotice = (): void => {
    if (!this.state.open) return
    this.change({ open: false, snoozedOn: this.today() })
  }

  /** Away from home, from the notice or Settings. Either choice in the
   * notice closes it, for good until `tell` is set again. */
  setQuality = (quality: AwayQuality): void => {
    this.change({ quality, open: false })
  }

  /** Another tab on this device changed what's stored. */
  reload = (): void => {
    this.change(readStored(this.storage))
  }

  private change(patch: Partial<AwayState>): void {
    const next = { ...this.state, ...patch }
    if (
      next.where === this.state.where &&
      next.quality === this.state.quality &&
      next.open === this.state.open &&
      next.snoozedOn === this.state.snoozedOn &&
      sameTrip(next.trip, this.state.trip)
    ) {
      return
    }
    this.state = next
    this.persist()
    for (const listener of this.listeners) listener()
  }

  private persist(): void {
    const { storage } = this
    if (!storage) return
    try {
      storage.setItem(AWAY_QUALITY_KEY, this.state.quality)
      if (this.state.trip) storage.setItem(AWAY_TRIP_KEY, JSON.stringify(this.state.trip))
      else storage.removeItem(AWAY_TRIP_KEY)
      if (this.state.snoozedOn) storage.setItem(AWAY_SNOOZE_KEY, this.state.snoozedOn)
      else storage.removeItem(AWAY_SNOOZE_KEY)
    } catch {
      // Storage full or refused: the notice still works for this visit.
    }
  }
}

function sameTrip(a: Trip | null, b: Trip | null): boolean {
  return a === b || (a != null && b != null && a.startedOn === b.startedOn && a.shown === b.shown)
}

export const awayFromHome = new AwayStore()

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === null || [AWAY_QUALITY_KEY, AWAY_TRIP_KEY, AWAY_SNOOZE_KEY].includes(event.key)) awayFromHome.reload()
  })
}

export function useAwayFromHome(): AwayState {
  return useSyncExternalStore(awayFromHome.subscribe, awayFromHome.snapshot)
}

/** What the quality ladder reads (playback/quality.ts): whether the server
 * says this device is away, and the pick for when it is. */
export function awayLadder(state: AwayState = awayFromHome.snapshot()): { away: boolean; pick: AwayQuality } {
  return { away: state.where === 'away', pick: state.quality }
}
