import { describe, expect, it } from 'vitest'
import { NODE_TYPES, nodeSizeScale, nodeSizeSettingKey, nodeSizeSettings, resolveNodeSizeMultipliers } from './nodeTypes'

describe('NODE_TYPES', () => {
  it('lists every type a label, and no duplicates', () => {
    expect(NODE_TYPES.length).toBeGreaterThan(0)
    const types = NODE_TYPES.map((t) => t.type)
    expect(new Set(types).size).toBe(types.length)
    for (const info of NODE_TYPES) {
      expect(info.label.length).toBeGreaterThan(0)
    }
  })
})

describe('resolveNodeSizeMultipliers', () => {
  it('reads a nodeSize:<type> setting per type', () => {
    const result = resolveNodeSizeMultipliers({
      [nodeSizeSettingKey('artist')]: '1.50',
      replaygainMode: 'track',
    })
    expect(result.artist).toBe(1.5)
  })

  it('falls back to 1 for a missing or non-numeric setting', () => {
    const result = resolveNodeSizeMultipliers({ [nodeSizeSettingKey('release')]: 'nonsense' })
    for (const { type } of NODE_TYPES) {
      expect(result[type]).toBe(1)
    }
  })
})

// #467: one node size slider for every kind of node.
describe('nodeSizeScale and nodeSizeSettings', () => {
  it('writes every type at one value', () => {
    const written = nodeSizeSettings(1.5)
    expect(Object.keys(written).sort()).toEqual(NODE_TYPES.map(({ type }) => nodeSizeSettingKey(type)).sort())
    expect(new Set(Object.values(written))).toEqual(new Set(['1.50']))
    expect(nodeSizeScale(written)).toBe(1.5)
  })

  it('reads 1 for a library that never set a size', () => {
    expect(nodeSizeScale({})).toBe(1)
  })

  it('shows the mean of sizes the shipped panel set one type at a time', () => {
    const settings = { [nodeSizeSettingKey('artist')]: '0.6', [nodeSizeSettingKey('release')]: '0.6' }
    expect(nodeSizeScale(settings)).toBeCloseTo((0.6 * 2 + (NODE_TYPES.length - 2)) / NODE_TYPES.length)
  })
})
