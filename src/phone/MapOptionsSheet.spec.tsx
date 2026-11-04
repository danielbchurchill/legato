// @vitest-environment jsdom
import { act, createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { forceSettingsFromSettings, matchPreset } from '../canvas/mapPresets'
import { NODE_TYPES, nodeSizeSettingKey } from '../canvas/nodeTypes'
import type { MapPresetHistory } from '../hooks/useMapPresetHistory'
import type { Settings } from '../hooks/useSettings'
import { MapOptionsBody, MapOptionsHeader } from './MapOptionsSheet'

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

function render(settings: Settings) {
  const updateSettings = vi.fn(async (_partial: Settings) => undefined)
  const onDone = vi.fn()
  const current = forceSettingsFromSettings(settings)
  const mapPresets: MapPresetHistory = {
    current,
    activePreset: matchPreset(current),
    applyPreset: vi.fn(),
    restoreDefaults: vi.fn(),
    undo: vi.fn(),
    canUndo: false,
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() =>
    root.render(
      createElement(
        Fragment,
        null,
        createElement(MapOptionsHeader, { onDone }),
        createElement(MapOptionsBody, { settings, updateSettings, mapPresets }),
      ),
    ),
  )
  const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text)!
  const switchFor = (label: string) => container.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${label}"]`)!
  const slider = (label: string) => container.querySelector<HTMLElement>(`[role="slider"][aria-label="${label}"]`)!
  const press = (el: HTMLElement, key: string) => act(() => el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })))
  return { container, updateSettings, onDone, mapPresets, button, switchFor, slider, press }
}

describe("the phone's map options sheet (#467)", () => {
  it('heads the sheet with its name and a Done that closes it', () => {
    const { container, button, onDone } = render({})
    expect(container.querySelector('h2')?.textContent).toBe('Map options')
    act(() => button('Done').click())
    expect(onDone).toHaveBeenCalledOnce()
  })

  it("picks a layout from the desktop's presets, in the phone's 40px segmented control", () => {
    const { container, mapPresets } = render({})
    const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tablist"][aria-label="layout"] [role="tab"]')]
    expect(tabs.map((t) => t.textContent)).toEqual(['clusters', 'balanced', 'sprawl'])
    expect(tabs[1].getAttribute('aria-selected')).toBe('true')
    expect(tabs[0].className).toContain('touch-target')
    act(() => tabs[2].click())
    expect(mapPresets.applyPreset).toHaveBeenCalledWith('sprawl')
  })

  it('shows and hides the same kinds of node as the chips over the map, each chip a 44px target', () => {
    const { button, updateSettings } = render({ showCreditNodes: 'true' })
    expect(button('producers').getAttribute('aria-pressed')).toBe('true')
    expect(button('albums').className).toContain('touch-target')
    act(() => button('producers').click())
    expect(updateSettings).toHaveBeenLastCalledWith({ showCreditNodes: 'false' })
  })

  it("has the desktop's four switches at the phone's size, producer labels beside artist labels", () => {
    const { container, switchFor, updateSettings } = render({ colourEdgesByType: 'true' })
    const labels = [...container.querySelectorAll('[role="switch"]')].map((s) => s.getAttribute('aria-label'))
    expect(labels).toEqual(['Artist labels', 'Producer labels', 'Colour edges by type', 'Lock layout'])
    expect(switchFor('Colour edges by type').getAttribute('aria-checked')).toBe('true')
    expect(switchFor('Lock layout').innerHTML).toContain('h-[31px]')
    act(() => switchFor('Producer labels').click())
    act(() => switchFor('Lock layout').click())
    expect(updateSettings.mock.calls).toEqual([[{ showCreditLabels: 'false' }], [{ nodePositionsLocked: 'true' }]])
  })

  it('has every slider, each taking a touch 44px tall', () => {
    const { container, slider, press, updateSettings } = render({})
    const sliders = [...container.querySelectorAll('[role="slider"]')].map((s) => s.getAttribute('aria-label'))
    expect(sliders).toEqual(['spacing', 'pull of related music', 'gravity', 'node size', 'line width'])
    expect(slider('gravity').parentElement!.className).toContain('h-[44px]')
    press(slider('gravity'), 'ArrowRight')
    press(slider('node size'), 'ArrowLeft')
    press(slider('line width'), 'ArrowRight')
    expect(updateSettings.mock.calls).toEqual([
      [{ forceCenterStrength: '0.04' }],
      [Object.fromEntries(NODE_TYPES.map(({ type }) => [nodeSizeSettingKey(type), '0.95']))],
      [{ edgeWidthScale: '1.05' }],
    ])
  })

  it('restores the defaults, all four new options with the rest', () => {
    const { button, updateSettings } = render({ forceCenterStrength: '0.15', edgeWidthScale: '2.50', showCreditLabels: 'false' })
    act(() => button('Restore defaults').click())
    expect(updateSettings).toHaveBeenCalledOnce()
    expect(updateSettings.mock.calls[0][0]).toMatchObject({
      forceCenterStrength: '0.03',
      edgeWidthScale: '1.00',
      showCreditLabels: 'true',
      [nodeSizeSettingKey('recording')]: '1.00',
    })
    expect(button('Restore defaults').className).toContain('touch-target')
  })
})
