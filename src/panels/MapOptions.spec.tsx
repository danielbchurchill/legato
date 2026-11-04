// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { forceSettingsFromSettings, matchPreset } from '../canvas/mapPresets'
import { NODE_TYPES, nodeSizeSettingKey } from '../canvas/nodeTypes'
import type { MapPresetHistory } from '../hooks/useMapPresetHistory'
import type { Settings } from '../hooks/useSettings'
import { MapOptions } from './MapOptions'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []

beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })),
  )
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
})

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()))
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

function fakePresets(settings: Settings): MapPresetHistory {
  const current = forceSettingsFromSettings(settings)
  return { current, activePreset: matchPreset(current), applyPreset: vi.fn(), restoreDefaults: vi.fn(), undo: vi.fn(), canUndo: false }
}

function render(settings: Settings) {
  const updateSettings = vi.fn(async (_partial: Settings) => undefined)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(createElement(MapOptions, { settings, updateSettings, mapPresets: fakePresets(settings) })))
  const switchFor = (label: string) => container.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${label}"]`)!
  const slider = (label: string) => container.querySelector<HTMLElement>(`[role="slider"][aria-label="${label}"]`)!
  const press = (el: HTMLElement, key: string) => act(() => el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })))
  return { container, updateSettings, switchFor, slider, press }
}

describe('the map options popover (#467)', () => {
  it('has a producer labels switch beside artist labels, on until it is turned off', () => {
    const { container, switchFor, updateSettings } = render({ showCreditNodes: 'true' })
    const switches = [...container.querySelectorAll('[role="switch"]')].map((s) => s.getAttribute('aria-label'))
    expect(switches.indexOf('Producer labels')).toBe(switches.indexOf('Artist labels') + 1)
    expect(switchFor('Producer labels').getAttribute('aria-checked')).toBe('true')
    act(() => switchFor('Producer labels').click())
    expect(updateSettings).toHaveBeenLastCalledWith({ showCreditLabels: 'false' })
  })

  it('reads a saved producer labels setting', () => {
    const { switchFor } = render({ showCreditLabels: 'false' })
    expect(switchFor('Producer labels').getAttribute('aria-checked')).toBe('false')
  })

  it('moves gravity, the center force, a step at a time', () => {
    const { slider, press, updateSettings } = render({ forceCenterStrength: '0.05' })
    expect(slider('gravity').getAttribute('aria-valuenow')).toBe('0.05')
    press(slider('gravity'), 'ArrowRight')
    expect(updateSettings).toHaveBeenLastCalledWith({ forceCenterStrength: '0.06' })
  })

  it('sizes every kind of node with one slider', () => {
    const { slider, press, updateSettings } = render({})
    expect(slider('node size').getAttribute('aria-valuetext')).toBe('1.00×')
    press(slider('node size'), 'ArrowRight')
    expect(updateSettings).toHaveBeenLastCalledWith(Object.fromEntries(NODE_TYPES.map(({ type }) => [nodeSizeSettingKey(type), '1.05'])))
  })

  it('scales the line width', () => {
    const { slider, press, updateSettings } = render({ edgeWidthScale: '2.00' })
    expect(slider('line width').getAttribute('aria-valuenow')).toBe('2')
    press(slider('line width'), 'ArrowLeft')
    expect(updateSettings).toHaveBeenLastCalledWith({ edgeWidthScale: '1.95' })
  })

  it('restores the defaults of gravity, node size, line width and producer labels in one write', () => {
    const { container, updateSettings } = render({
      forceCenterStrength: '0.15',
      [nodeSizeSettingKey('artist')]: '1.80',
      edgeWidthScale: '2.50',
      showCreditLabels: 'false',
    })
    const restore = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Restore defaults')!
    act(() => restore.click())
    expect(updateSettings).toHaveBeenCalledOnce()
    expect(updateSettings.mock.calls[0][0]).toMatchObject({
      forceCenterStrength: '0.03',
      [nodeSizeSettingKey('artist')]: '1.00',
      edgeWidthScale: '1.00',
      showCreditLabels: 'true',
      forceRepelStrength: '150',
      showArtistLabels: 'true',
    })
  })
})
