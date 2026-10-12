// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MapControls } from './MapControls'
import type { Settings } from '../hooks/useSettings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()))
  document.body.innerHTML = ''
})

function render(settings: Settings, hidden = false) {
  const updateSettings = vi.fn(async () => undefined)
  const onOpenSearch = vi.fn()
  const onOpenSettings = vi.fn()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(createElement(MapControls, { settings, updateSettings, onOpenSearch, onOpenSettings, hidden })))
  const chip = (label: string) =>
    [...container.querySelectorAll<HTMLButtonElement>('[role="group"] button')].find((b) => b.textContent === label)!
  return { container, chip, updateSettings, onOpenSearch, onOpenSettings }
}

describe('MapControls', () => {
  it("shows the node types the map shows, by the desktop's own settings and defaults", () => {
    const { chip } = render({})
    expect(chip('artists').getAttribute('aria-pressed')).toBe('true')
    expect(chip('albums').getAttribute('aria-pressed')).toBe('true')
    expect(chip('tracks').getAttribute('aria-pressed')).toBe('true')
    // Producers and engineers are opt-in on the desktop too (#24).
    expect(chip('credits').getAttribute('aria-pressed')).toBe('false')
  })

  it('toggles the same settings the map options do', () => {
    const { chip, updateSettings } = render({ showTracks: 'false', showCreditNodes: 'true' })
    expect(chip('tracks').getAttribute('aria-pressed')).toBe('false')
    act(() => chip('tracks').click())
    act(() => chip('credits').click())
    act(() => chip('artists').click())
    expect(updateSettings.mock.calls).toEqual([[{ showTracks: 'true' }], [{ showCreditNodes: 'false' }], [{ showArtists: 'false' }]])
  })

  it('draws inactive types in ink-2 and active ones in ink', () => {
    const { chip } = render({ showReleases: 'false' })
    expect(chip('albums').className).toContain('text-[var(--color-ink-2)]')
    expect(chip('artists').className).toContain('text-[var(--color-ink)]')
  })

  it('opens search from the capsule and settings from the button beside it', () => {
    const { container, onOpenSearch, onOpenSettings } = render({})
    const capsule = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Search artists, albums, people')!
    act(() => capsule.click())
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Settings"]')!.click())
    expect(onOpenSearch).toHaveBeenCalledOnce()
    expect(onOpenSettings).toHaveBeenCalledOnce()
  })

  it('takes itself out of reach while the sheet is large', () => {
    const { container } = render({}, true)
    expect(container.firstElementChild!.hasAttribute('inert')).toBe(true)
  })
})
