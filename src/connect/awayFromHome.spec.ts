import { describe, expect, it } from 'vitest'
import {
  AWAY_QUALITY_KEY,
  AWAY_SNOOZE_KEY,
  AWAY_TRIP_KEY,
  AwayStore,
  afterAnswer,
  awayLadder,
  localDate,
  noticeDue,
  type AwayState,
} from './awayFromHome'

// #412's rule, as DESIGN.md's "Away from home" has it.

class MemoryStorage implements Storage {
  private items = new Map<string, string>()
  get length() {
    return this.items.size
  }
  clear() {
    this.items.clear()
  }
  getItem(key: string) {
    return this.items.get(key) ?? null
  }
  key(index: number) {
    return [...this.items.keys()][index] ?? null
  }
  removeItem(key: string) {
    this.items.delete(key)
  }
  setItem(key: string, value: string) {
    this.items.set(key, value)
  }
}

/** A device: its storage, its clock, and a store over them. `launch()` is
 * the app opening again on the same device. */
function device(today = '2026-11-09') {
  const storage = new MemoryStorage()
  const clock = { today }
  const make = () => new AwayStore({ storage, today: () => clock.today })
  const it = { storage, clock, store: make(), launch: () => (it.store = make()) }
  return it
}

// Everything but the trip, the snooze and the pick holds: a FLAC playing at
// original quality, in front, with nothing in the way.
const PLAYING_FLAC = { streamingOriginal: true, kbps: 900, visible: true, interrupted: false }

function due(state: AwayState, overrides: Partial<Parameters<typeof noticeDue>[0]> = {}): boolean {
  return noticeDue({ quality: state.quality, trip: state.trip, snoozedOn: state.snoozedOn, ...PLAYING_FLAC, ...overrides })
}

/** What the notice host does when the rule says so. */
function showIfDue(store: AwayStore): boolean {
  if (!due(store.snapshot())) return false
  store.showNotice()
  return true
}

describe('trips', () => {
  it("starts at the first 'away', ends at the next 'home', and 'unknown' does neither", () => {
    expect(afterAnswer('unknown', { trip: null, snoozedOn: null }, '2026-11-09')).toEqual({ trip: null, snoozedOn: null })
    const started = afterAnswer('away', { trip: null, snoozedOn: null }, '2026-11-09')
    expect(started.trip).toEqual({ startedOn: '2026-11-09', shown: false })
    // Another 'away', a day later, is the same trip.
    expect(afterAnswer('away', started, '2026-11-10').trip).toEqual({ startedOn: '2026-11-09', shown: false })
    expect(afterAnswer('unknown', started, '2026-11-10').trip).toEqual({ startedOn: '2026-11-09', shown: false })
    expect(afterAnswer('home', started, '2026-11-10').trip).toBeNull()
  })

  it('outlasts a relaunch while the device stays away', () => {
    const phone = device()
    phone.store.setWhereabouts('away')
    expect(showIfDue(phone.store)).toBe(true)
    phone.launch()
    // A new launch knows nothing until the server answers, and 'away'
    // again is the same trip, already shown.
    expect(phone.store.snapshot().where).toBe('unknown')
    phone.store.setWhereabouts('away')
    expect(showIfDue(phone.store)).toBe(false)
  })
})

describe('the notice', () => {
  it('shows once a trip, not on every track', () => {
    const phone = device()
    phone.store.setWhereabouts('away')
    expect(showIfDue(phone.store)).toBe(true)
    expect(phone.store.snapshot().open).toBe(true)
    phone.store.setQuality('same')
    phone.store.setQuality('tell')
    // The next track, the same trip: nothing.
    expect(showIfDue(phone.store)).toBe(false)
    phone.store.setWhereabouts('home')
    phone.store.setWhereabouts('away')
    expect(showIfDue(phone.store)).toBe(true)
  })

  it("never shows at home, while the server doesn't know, or before the track streams the original", () => {
    const phone = device()
    phone.store.setWhereabouts('home')
    expect(due(phone.store.snapshot())).toBe(false)
    phone.store.setWhereabouts('unknown')
    expect(due(phone.store.snapshot())).toBe(false)
    phone.store.setWhereabouts('away')
    expect(due(phone.store.snapshot(), { streamingOriginal: false })).toBe(false)
    expect(due(phone.store.snapshot())).toBe(true)
  })

  it("isn't shown under 320 kbps, or without a bitrate to say", () => {
    const phone = device()
    phone.store.setWhereabouts('away')
    expect(due(phone.store.snapshot(), { kbps: 128 })).toBe(false)
    expect(due(phone.store.snapshot(), { kbps: 319 })).toBe(false)
    expect(due(phone.store.snapshot(), { kbps: null })).toBe(false)
    expect(due(phone.store.snapshot(), { kbps: 320 })).toBe(true)
  })

  it('waits while the page is hidden, or something it waits for is going on', () => {
    const phone = device()
    phone.store.setWhereabouts('away')
    expect(due(phone.store.snapshot(), { visible: false })).toBe(false)
    expect(due(phone.store.snapshot(), { interrupted: true })).toBe(false)
    expect(due(phone.store.snapshot())).toBe(true)
  })

  it("closed without choosing, it's snoozed until a later day: a commuter's evening trip doesn't bring it back", () => {
    const phone = device('2026-11-09')
    phone.store.setWhereabouts('away')
    expect(showIfDue(phone.store)).toBe(true)
    phone.store.dismissNotice()
    expect(phone.store.snapshot()).toMatchObject({ open: false, quality: 'tell', snoozedOn: '2026-11-09' })
    expect(phone.storage.getItem(AWAY_SNOOZE_KEY)).toBe('2026-11-09')

    // Home after work, out again in the evening: the same day.
    phone.store.setWhereabouts('home')
    phone.store.setWhereabouts('away')
    expect(showIfDue(phone.store)).toBe(false)

    // The next morning's trip clears the snooze.
    phone.store.setWhereabouts('home')
    phone.clock.today = '2026-11-10'
    phone.launch()
    phone.store.setWhereabouts('away')
    expect(phone.store.snapshot().snoozedOn).toBeNull()
    expect(showIfDue(phone.store)).toBe(true)
  })

  it('a trip that began before the snooze stays snoozed past midnight', () => {
    const phone = device('2026-11-09')
    phone.store.setWhereabouts('away')
    showIfDue(phone.store)
    phone.store.dismissNotice()
    phone.clock.today = '2026-11-10'
    phone.store.setWhereabouts('away')
    expect(showIfDue(phone.store)).toBe(false)
  })

  it('either choice ends it for good, until tell me is set again', () => {
    for (const choice of ['standard', 'same'] as const) {
      const phone = device('2026-11-09')
      phone.store.setWhereabouts('away')
      showIfDue(phone.store)
      phone.store.setQuality(choice)
      expect(phone.store.snapshot()).toMatchObject({ open: false, quality: choice, snoozedOn: null })
      expect(phone.storage.getItem(AWAY_QUALITY_KEY)).toBe(choice)

      // Days of trips later, nothing.
      for (const day of ['2026-11-10', '2026-11-11']) {
        phone.store.setWhereabouts('home')
        phone.clock.today = day
        phone.launch()
        phone.store.setWhereabouts('away')
        expect(showIfDue(phone.store)).toBe(false)
      }

      // Settings → Away from home → tell me, and the next trip tells.
      phone.store.setQuality('tell')
      phone.store.setWhereabouts('home')
      phone.store.setWhereabouts('away')
      expect(showIfDue(phone.store)).toBe(true)
    }
  })

  it('closes by itself when the device is seen at home, and counts as never shown', () => {
    const phone = device()
    phone.store.setWhereabouts('away')
    showIfDue(phone.store)
    phone.store.setWhereabouts('home')
    expect(phone.store.snapshot()).toMatchObject({ open: false, trip: null, snoozedOn: null })
    expect(phone.storage.getItem(AWAY_TRIP_KEY)).toBeNull()
    phone.store.setWhereabouts('away')
    expect(showIfDue(phone.store)).toBe(true)
  })

  it("stays open while the server stops knowing, and 'unknown' never closes it", () => {
    const phone = device()
    phone.store.setWhereabouts('away')
    showIfDue(phone.store)
    phone.store.setWhereabouts('unknown')
    expect(phone.store.snapshot().open).toBe(true)
  })
})

describe('storage', () => {
  it('keeps the pick, the trip and the snooze under their own keys, and reads them back', () => {
    const phone = device()
    phone.store.setQuality('standard')
    phone.store.setWhereabouts('away')
    expect(phone.storage.getItem(AWAY_QUALITY_KEY)).toBe('standard')
    expect(JSON.parse(phone.storage.getItem(AWAY_TRIP_KEY)!)).toEqual({ startedOn: '2026-11-09', shown: false })
    phone.launch()
    expect(phone.store.snapshot()).toMatchObject({ quality: 'standard', trip: { startedOn: '2026-11-09', shown: false } })
  })

  it("reads anything it doesn't know as the defaults", () => {
    const phone = device()
    phone.storage.setItem(AWAY_QUALITY_KEY, 'sometimes')
    phone.storage.setItem(AWAY_TRIP_KEY, '{not json')
    phone.storage.setItem(AWAY_SNOOZE_KEY, 'yesterday')
    phone.launch()
    expect(phone.store.snapshot()).toMatchObject({ quality: 'tell', trip: null, snoozedOn: null })
  })
})

describe('awayLadder', () => {
  it('is away only while the server says so, with the pick beside it', () => {
    const phone = device()
    phone.store.setQuality('standard')
    expect(awayLadder(phone.store.snapshot())).toEqual({ away: false, pick: 'standard' })
    phone.store.setWhereabouts('away')
    expect(awayLadder(phone.store.snapshot())).toEqual({ away: true, pick: 'standard' })
    phone.store.setWhereabouts('unknown')
    expect(awayLadder(phone.store.snapshot())).toEqual({ away: false, pick: 'standard' })
  })
})

describe('localDate', () => {
  it('is the local calendar date', () => {
    expect(localDate(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05')
    expect(localDate(new Date(2026, 10, 9, 0, 1))).toBe('2026-11-09')
  })
})
