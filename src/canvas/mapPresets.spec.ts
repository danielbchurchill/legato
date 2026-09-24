import { describe, expect, it } from 'vitest'
import {
  BALANCED_FORCE_SETTINGS,
  MAP_PRESETS,
  canUndoForceChange,
  forceSettingsFromSettings,
  forceSettingsToPartialSettings,
  initForceHistory,
  matchPreset,
  recordForceChange,
  undoForceChange,
  type ForceSettings,
} from './mapPresets'

// This repo's first frontend unit tests (#127) — pure logic only, no React
// or DOM involved, matching server/'s own vitest convention of a *.spec.ts
// file adjacent to the source it covers.

describe('mapPresets', () => {
  describe('MAP_PRESETS', () => {
    it('balanced is exactly today\'s defaults', () => {
      expect(MAP_PRESETS.balanced).toEqual(BALANCED_FORCE_SETTINGS)
    })

    it('clusters and sprawl only move link force and repel, not center or distance', () => {
      for (const id of ['clusters', 'sprawl'] as const) {
        expect(MAP_PRESETS[id].forceCenterStrength).toBe(BALANCED_FORCE_SETTINGS.forceCenterStrength)
        expect(MAP_PRESETS[id].linkDistance).toBe(BALANCED_FORCE_SETTINGS.linkDistance)
      }
    })

    it('clusters is stronger link, lower repel than balanced; sprawl the reverse', () => {
      expect(MAP_PRESETS.clusters.forceLinkStrength).toBeGreaterThan(BALANCED_FORCE_SETTINGS.forceLinkStrength)
      expect(MAP_PRESETS.clusters.forceRepelStrength).toBeLessThan(BALANCED_FORCE_SETTINGS.forceRepelStrength)
      expect(MAP_PRESETS.sprawl.forceLinkStrength).toBeLessThan(BALANCED_FORCE_SETTINGS.forceLinkStrength)
      expect(MAP_PRESETS.sprawl.forceRepelStrength).toBeGreaterThan(BALANCED_FORCE_SETTINGS.forceRepelStrength)
    })

    it('every preset value stays within its slider\'s real range', () => {
      for (const forces of Object.values(MAP_PRESETS)) {
        expect(forces.forceCenterStrength).toBeGreaterThanOrEqual(0)
        expect(forces.forceCenterStrength).toBeLessThanOrEqual(1)
        expect(forces.forceLinkStrength).toBeGreaterThanOrEqual(0)
        expect(forces.forceLinkStrength).toBeLessThanOrEqual(1)
        expect(forces.forceRepelStrength).toBeGreaterThanOrEqual(0)
        expect(forces.forceRepelStrength).toBeLessThanOrEqual(200)
        expect(forces.linkDistance).toBeGreaterThanOrEqual(20)
        expect(forces.linkDistance).toBeLessThanOrEqual(300)
      }
    })
  })

  describe('forceSettingsFromSettings', () => {
    it('reads today\'s defaults from an empty settings store', () => {
      expect(forceSettingsFromSettings({})).toEqual(BALANCED_FORCE_SETTINGS)
    })

    it('parses real stored values', () => {
      expect(
        forceSettingsFromSettings({
          forceCenterStrength: '0.10',
          forceRepelStrength: '75',
          forceLinkStrength: '0.40',
          linkDistance: '120',
        }),
      ).toEqual({ forceCenterStrength: 0.1, forceRepelStrength: 75, forceLinkStrength: 0.4, linkDistance: 120 })
    })

    it('falls back to the default for a garbage or missing value, matching MusicMapSettings.tsx\'s own parseMultiplier', () => {
      expect(forceSettingsFromSettings({ forceRepelStrength: 'not-a-number' }).forceRepelStrength).toBe(
        BALANCED_FORCE_SETTINGS.forceRepelStrength,
      )
    })
  })

  describe('forceSettingsToPartialSettings / matchPreset round trip', () => {
    it('every preset survives a round trip through the string-settings format it\'s written as', () => {
      for (const [id, forces] of Object.entries(MAP_PRESETS) as [keyof typeof MAP_PRESETS, ForceSettings][]) {
        const roundTripped = forceSettingsFromSettings(forceSettingsToPartialSettings(forces))
        expect(matchPreset(roundTripped)).toBe(id)
      }
    })

    it('formats strength sliders to 2 decimals and count/distance sliders to whole units', () => {
      const partial = forceSettingsToPartialSettings(MAP_PRESETS.clusters)
      expect(partial.forceLinkStrength).toBe('0.40')
      expect(partial.forceCenterStrength).toBe('0.03')
      expect(partial.forceRepelStrength).toBe('40')
      expect(partial.linkDistance).toBe('80')
    })
  })

  describe('matchPreset', () => {
    it('returns null once a slider has moved off every named preset', () => {
      expect(matchPreset({ ...BALANCED_FORCE_SETTINGS, forceLinkStrength: 0.22 })).toBeNull()
    })
  })

  describe('force history (session undo)', () => {
    it('starts with nothing to undo', () => {
      const state = initForceHistory(BALANCED_FORCE_SETTINGS)
      expect(canUndoForceChange(state)).toBe(false)
    })

    it('records a change and makes it undoable back to the prior value', () => {
      let state = initForceHistory(BALANCED_FORCE_SETTINGS)
      state = recordForceChange(state, MAP_PRESETS.clusters, 1_000)
      expect(canUndoForceChange(state)).toBe(true)
      expect(state.present).toEqual(MAP_PRESETS.clusters)

      state = undoForceChange(state, 2_000)
      expect(state.present).toEqual(BALANCED_FORCE_SETTINGS)
      expect(canUndoForceChange(state)).toBe(false)
    })

    it('undoing with nothing to undo is a no-op, returned by reference', () => {
      const state = initForceHistory(BALANCED_FORCE_SETTINGS)
      expect(undoForceChange(state, 500)).toBe(state)
    })

    it('recording an identical value changes nothing, returned by reference', () => {
      const state = initForceHistory(BALANCED_FORCE_SETTINGS)
      expect(recordForceChange(state, { ...BALANCED_FORCE_SETTINGS }, 100)).toBe(state)
    })

    it('coalesces rapid changes (one slider drag) into a single undo step', () => {
      let state = initForceHistory(BALANCED_FORCE_SETTINGS)
      // A drag: many intermediate onChange values, all within the coalesce
      // window of the one before it.
      state = recordForceChange(state, { ...BALANCED_FORCE_SETTINGS, forceLinkStrength: 0.2 }, 100)
      state = recordForceChange(state, { ...BALANCED_FORCE_SETTINGS, forceLinkStrength: 0.3 }, 200)
      state = recordForceChange(state, { ...BALANCED_FORCE_SETTINGS, forceLinkStrength: 0.4 }, 300)
      expect(state.past).toEqual([BALANCED_FORCE_SETTINGS])

      // One undo returns all the way to before the drag started, not to the
      // drag's own previous intermediate frame.
      state = undoForceChange(state, 400)
      expect(state.present).toEqual(BALANCED_FORCE_SETTINGS)
    })

    it('a change after the coalesce window opens a new, separate undo step', () => {
      let state = initForceHistory(BALANCED_FORCE_SETTINGS)
      state = recordForceChange(state, { ...BALANCED_FORCE_SETTINGS, forceLinkStrength: 0.2 }, 100)
      // Well past the 500ms coalesce window.
      state = recordForceChange(state, { ...BALANCED_FORCE_SETTINGS, forceLinkStrength: 0.2, forceRepelStrength: 50 }, 900)
      expect(state.past).toEqual([BALANCED_FORCE_SETTINGS, { ...BALANCED_FORCE_SETTINGS, forceLinkStrength: 0.2 }])

      state = undoForceChange(state, 1_000)
      expect(state.present).toEqual({ ...BALANCED_FORCE_SETTINGS, forceLinkStrength: 0.2 })
      state = undoForceChange(state, 1_100)
      expect(state.present).toEqual(BALANCED_FORCE_SETTINGS)
    })

    it('undo is repeatable back through several checkpoints, in order', () => {
      let state = initForceHistory(MAP_PRESETS.balanced)
      state = recordForceChange(state, MAP_PRESETS.clusters, 1_000)
      state = recordForceChange(state, MAP_PRESETS.sprawl, 2_000)

      state = undoForceChange(state, 3_000)
      expect(state.present).toEqual(MAP_PRESETS.clusters)
      state = undoForceChange(state, 4_000)
      expect(state.present).toEqual(MAP_PRESETS.balanced)
      expect(canUndoForceChange(state)).toBe(false)
    })

    it('caps history length rather than growing unbounded across a long session', () => {
      let state = initForceHistory(BALANCED_FORCE_SETTINGS)
      // Each change is its own checkpoint, spaced well past the coalesce window.
      for (let i = 0; i < 60; i++) {
        state = recordForceChange(state, { ...BALANCED_FORCE_SETTINGS, forceLinkStrength: i / 100 }, (i + 1) * 1_000)
      }
      expect(state.past.length).toBeLessThanOrEqual(50)
    })
  })
})
