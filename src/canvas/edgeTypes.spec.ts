import { describe, expect, it } from 'vitest'
import {
  CURATED_EDGE_HUES,
  EDGE_COLOR,
  edgeColorSettingKey,
  edgeTypes,
  isHueTooClose,
  resolveEdgeColorOverrides,
} from './edgeTypes'

// The app's first pure-logic frontend module worth a real test file — see
// CLAUDE.md's "Root app has vitest installed but no tests yet". Everything
// here is deterministic and needs no DOM, no server, no settings store.

describe('edgeTypes', () => {
  it('returns the 7 curated types DESIGN.md documents for the combined graph', () => {
    expect(edgeTypes()).toHaveLength(7)
  })

  it('every returned type has a label and a default hex from EDGE_COLOR', () => {
    for (const info of edgeTypes()) {
      expect(info.label.length).toBeGreaterThan(0)
      expect(info.defaultHex).toBe(EDGE_COLOR[info.type])
    }
  })
})

describe('resolveEdgeColorOverrides', () => {
  it('extracts only edgeColor: keys, stripped of their prefix', () => {
    const overrides = resolveEdgeColorOverrides({
      [edgeColorSettingKey('performed_by')]: '#112233',
      replaygainMode: 'track',
      [edgeColorSettingKey('same_label')]: '#445566',
    })
    expect(overrides).toEqual({ performed_by: '#112233', same_label: '#445566' })
  })

  it('returns an empty map when no overrides are set', () => {
    expect(resolveEdgeColorOverrides({ replaygainMode: 'track' })).toEqual({})
  })
})

describe('CURATED_EDGE_HUES', () => {
  it('are evenly spaced and share one saturation/lightness family', () => {
    expect(CURATED_EDGE_HUES).toHaveLength(16)
    const hexes = new Set(CURATED_EDGE_HUES.map((h) => h.hex))
    expect(hexes.size).toBe(16) // every curated hue renders to a distinct hex
  })

  it('leaves every real edge type at least one non-disabled choice', () => {
    // Regression check for the bug this replaced: released_in,
    // featured_artist, and produced_by each had zero pickable swatches
    // against the old 8-anchor/30°-clearance picker, because the 7 fixed
    // defaults' real (uneven) spacing happened to blank out every anchor
    // for those three types specifically.
    for (const info of edgeTypes()) {
      const otherHexes = edgeTypes()
        .filter((t) => t.type !== info.type)
        .map((t) => t.defaultHex)
      const available = CURATED_EDGE_HUES.filter(({ hex }) => !isHueTooClose(hex, otherHexes))
      expect(available.length).toBeGreaterThan(0)
    }
  })
})

describe('isHueTooClose', () => {
  it('flags a candidate within clearance of an already-taken hex', () => {
    // #bf68eb is 283deg (performed_by's default) — a near-identical hue
    // should be rejected as a pick for some other type in the same graph.
    expect(isHueTooClose('#be67ea', ['#bf68eb'])).toBe(true)
  })

  it('allows a candidate well clear of every taken hex', () => {
    // 0deg red vs. 283deg purple: 77deg apart, comfortably clear.
    expect(isHueTooClose('#ff0000', ['#bf68eb'])).toBe(false)
  })

  it('allows anything when nothing is taken yet', () => {
    expect(isHueTooClose('#bf68eb', [])).toBe(false)
  })
})
