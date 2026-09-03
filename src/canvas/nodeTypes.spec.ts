import { describe, expect, it } from 'vitest'
import { NODE_TYPES, nodeSizeSettingKey, resolveNodeSizeMultipliers } from './nodeTypes'

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
