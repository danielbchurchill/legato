import { describe, expect, it } from 'vitest'
import { BALANCED_FORCE_SETTINGS, MAP_PRESETS, matchPreset, forceSettingsFromSettings } from '../canvas/mapPresets'
import { NODE_TYPES, nodeSizeSettingKey, resolveNodeSizeMultipliers } from '../canvas/nodeTypes'
import { resolveEdgeWidthScale } from '../canvas/edgeWidth'
import { MAP_SLIDERS, MAP_SWITCHES, isSharedMapSetting, mapOptionDefaults } from './mapOptionSettings'
import { isOn } from './mapShow'

const slider = (label: string) => MAP_SLIDERS.find((s) => s.label === label)!

describe('the map options (#467)', () => {
  it('puts producer labels beside artist labels, on by default as they always were', () => {
    const keys = MAP_SWITCHES.map((s) => s.key)
    expect(keys.indexOf('showCreditLabels')).toBe(keys.indexOf('showArtistLabels') + 1)
    expect(isOn({}, 'showCreditLabels', MAP_SWITCHES[1].defaultOn)).toBe(true)
  })

  it('has a slider for gravity, node size and line width beside the two forces', () => {
    expect(MAP_SLIDERS.map((s) => s.label)).toEqual(['spacing', 'pull of related music', 'gravity', 'node size', 'line width'])
  })

  it('reads and writes gravity as the center force, in the steps the presets write', () => {
    const gravity = slider('gravity')
    expect(gravity.value({})).toBe(BALANCED_FORCE_SETTINGS.forceCenterStrength)
    expect(gravity.write(0.12)).toEqual({ forceCenterStrength: '0.12' })
    expect(gravity.value({ forceCenterStrength: '0.12' })).toBe(0.12)
    // Every preset's gravity is a stop on the slider.
    for (const preset of Object.values(MAP_PRESETS)) {
      const stops = Math.round((preset.forceCenterStrength - gravity.min) / gravity.step)
      expect(gravity.min + stops * gravity.step).toBeCloseTo(preset.forceCenterStrength)
    }
  })

  it('moves gravity off a preset leaving no preset selected, as the other two forces do', () => {
    expect(matchPreset(forceSettingsFromSettings({}))).toBe('balanced')
    expect(matchPreset(forceSettingsFromSettings(slider('gravity').write(0.1)))).toBeNull()
  })

  it('sizes every kind of node with one slider', () => {
    const written = slider('node size').write(1.4)
    expect(Object.values(resolveNodeSizeMultipliers(written))).toEqual(NODE_TYPES.map(() => 1.4))
    expect(slider('node size').value(written)).toBeCloseTo(1.4)
  })

  it('scales the line width with its own setting', () => {
    const written = slider('line width').write(2.25)
    expect(resolveEdgeWidthScale(written)).toBe(2.25)
    expect(slider('line width').value(written)).toBe(2.25)
  })

  it('starts every slider inside its range', () => {
    for (const s of MAP_SLIDERS) {
      const value = s.value({})
      expect(value).toBeGreaterThanOrEqual(s.min)
      expect(value).toBeLessThanOrEqual(s.max)
    }
  })

  it('restores the defaults of all four new options with everything else, in one write', () => {
    const changed = {
      ...slider('gravity').write(0.15),
      ...slider('node size').write(1.8),
      ...slider('line width').write(2.5),
      showCreditLabels: 'false',
      forceRepelStrength: '20',
    }
    const restored = { ...changed, ...mapOptionDefaults() }
    expect(slider('gravity').value(restored)).toBe(BALANCED_FORCE_SETTINGS.forceCenterStrength)
    expect(slider('node size').value(restored)).toBe(1)
    expect(slider('line width').value(restored)).toBe(1)
    expect(isOn(restored, 'showCreditLabels', true)).toBe(true)
    expect(matchPreset(forceSettingsFromSettings(restored))).toBe('balanced')
    expect(restored).toMatchObject({
      showArtists: 'true',
      showCreditNodes: 'false',
      showArtistLabels: 'true',
      nodePositionsLocked: 'false',
    })
  })

  it("shares the map's settings live, and nothing else", () => {
    for (const key of Object.keys(mapOptionDefaults())) expect(isSharedMapSetting(key)).toBe(true)
    expect(isSharedMapSetting(nodeSizeSettingKey('credit'))).toBe(true)
    expect(isSharedMapSetting('edgeColor:produced_by')).toBe(true)
    for (const key of ['viewMode', 'repeatMode', 'audioDevice', 'replaygainMode', 'enrichmentEnabled', 'reducedMotionForced']) {
      expect(isSharedMapSetting(key)).toBe(false)
    }
  })
})
