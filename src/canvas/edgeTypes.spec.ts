import { describe, expect, it } from 'vitest'
import {
  CURATED_EDGE_HUES,
  EDGE_COLOR,
  edgeColorSettingKey,
  edgeTypesForGranularity,
  isHueTooClose,
  resolveEdgeColorOverrides,
} from './edgeTypes'

// The app's first pure-logic frontend module worth a real test file — see
// CLAUDE.md's "Root app has vitest installed but no tests yet". Everything
// here is deterministic and needs no DOM, no server, no settings store.

describe('edgeTypesForGranularity', () => {
  it('returns the 7/2/1 type counts DESIGN.md documents per graph', () => {
    expect(edgeTypesForGranularity('tracks')).toHaveLength(7)
    expect(edgeTypesForGranularity('albums')).toHaveLength(2)
    expect(edgeTypesForGranularity('artists')).toHaveLength(1)
  })

  it('every returned type has a label and a default hex from EDGE_COLOR', () => {
    for (const granularity of ['tracks', 'albums', 'artists'] as const) {
      for (const info of edgeTypesForGranularity(granularity)) {
        expect(info.label.length).toBeGreaterThan(0)
        expect(info.defaultHex).toBe(EDGE_COLOR[info.type])
      }
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
    expect(CURATED_EDGE_HUES).toHaveLength(8)
    const hexes = new Set(CURATED_EDGE_HUES.map((h) => h.hex))
    expect(hexes.size).toBe(8) // every curated hue renders to a distinct hex
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
