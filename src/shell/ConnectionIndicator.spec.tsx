// @vitest-environment jsdom
// Issue #118: the connection-path indicator in the rail.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import globeSvg from '../assets/icons/globe.svg?raw'
import homeSvg from '../assets/icons/home.svg?raw'
import { awayFromHome } from '../connect/awayFromHome'
import { setConnectionPath } from '../connect/connectionPath'
import { noteDrop, storeQualityPreference, streamUrl } from '../playback/quality'
import { ConnectionIndicator } from './ConnectionIndicator'

const roots: Root[] = []

// Each glyph's outline, from the vendored SVG itself.
const outline = (svg: string) => / d="([^"]+)"/.exec(svg)![1]
const globe = outline(globeSvg)
const home = outline(homeSvg)

beforeEach(() => {
  // jsdom has no ResizeObserver; the popover measures itself with one.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  // Nor matchMedia, which the popover asks about reduced motion.
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })),
  )
  localStorage.clear()
  storeQualityPreference('auto')
})

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()))
  act(() => setConnectionPath('this-computer'))
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
  // Back to a device the server has said nothing about.
  act(() => {
    awayFromHome.setWhereabouts('home')
    awayFromHome.setWhereabouts('unknown')
  })
  localStorage.clear()
  awayFromHome.reload()
})

function render(props: { embedded?: boolean; currentFileId?: number | null; streaming?: boolean; onOpenSettings?: () => void } = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => {
    root.render(
      createElement(ConnectionIndicator, { embedded: false, currentFileId: null, streaming: false, onOpenSettings: () => undefined, ...props }),
    )
  })
  const button = () => container.querySelector<HTMLButtonElement>('button')!
  const open = () => act(() => button().click())
  const popover = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Connection"]')
  // The glyph's outline, as Icon.tsx draws it.
  const glyph = () => button().querySelector('path')!.getAttribute('d')
  return { button, open, popover, glyph }
}

describe('ConnectionIndicator', () => {
  it('names the path and the quality in its accessible name, which is its tooltip', () => {
    const { button } = render()
    expect(button().getAttribute('aria-label')).toBe('This computer · original')
    expect(button().getAttribute('aria-haspopup')).toBe('dialog')
  })

  it('explains the path, the address and the quality when opened', () => {
    // What the server called itself when it last answered this page's base.
    localStorage.setItem('legato:last-seen', JSON.stringify({ 'http://127.0.0.1:8899': { at: '2026-10-10T10:00:00Z', name: 'musicbox' } }))
    const { open, popover, button } = render()
    open()
    expect(button().getAttribute('aria-expanded')).toBe('true')
    const text = popover()!.textContent
    expect(text).toContain('This computer')
    expect(text).toContain('Connected to musicbox directly, on this computer.')
    expect(text).toContain('127.0.0.1:8899')
    expect(text).toContain('Streams at original quality, the default on this computer.')
  })

  it("names the desktop app's own server, without its address", () => {
    const { open, popover } = render({ embedded: true })
    open()
    expect(popover()!.textContent).toContain("Connected to Legato's own server, running on this computer.")
    expect(popover()!.textContent).not.toContain('127.0.0.1')
  })

  it('updates as the path changes', () => {
    const { button } = render()
    act(() => setConnectionPath('home'))
    expect(button().getAttribute('aria-label')).toBe('Home network · original')
    act(() => setConnectionPath('relay'))
    // jsdom can't play Opus, so it gets the AAC rung, as Safari does.
    expect(button().getAttribute('aria-label')).toBe('Through legato.fm · AAC 160 kbps')
    act(() => setConnectionPath('custom'))
    expect(button().getAttribute('aria-label')).toBe('Custom address · AAC 256 kbps')
  })

  it("shows the playing track's quality, and the next one's after a drop", () => {
    act(() => setConnectionPath('custom'))
    streamUrl(7)
    const { button, open, popover } = render({ currentFileId: 7 })
    act(() => noteDrop())
    expect(button().getAttribute('aria-label')).toBe('Custom address · AAC 256 kbps')
    open()
    expect(popover()!.textContent).toContain(
      'This track streams as AAC at 256 kbps. The next one streams as AAC at 160 kbps, lowered after the connection dropped.',
    )
  })

  // #495: the server's home/away answer for this device (#412). A Tailscale
  // address is the home path wherever the device is.
  describe('away from home', () => {
    beforeEach(() => act(() => setConnectionPath('home')))

    it("leaves the home network's name and glyph while the server doesn't know", () => {
      const { button, glyph } = render()
      expect(awayFromHome.snapshot().where).toBe('unknown')
      expect(button().getAttribute('aria-label')).toBe('Home network · original')
      expect(glyph()).toBe(home)
    })

    // What the popover says about the place and the quality.
    const said = (popover: HTMLElement) => ({
      heading: popover.querySelector('h2')!.textContent,
      sentences: [...popover.querySelectorAll('p')].map((p) => p.textContent),
    })

    beforeEach(() => {
      localStorage.setItem('legato:last-seen', JSON.stringify({ 'http://127.0.0.1:8899': { at: '2026-11-12T10:00:00Z', name: 'musicbox' } }))
    })

    const AT_HOME = {
      heading: 'Home network',
      sentences: [
        'Connected to musicbox directly, on your home network.',
        '127.0.0.1:8899',
        'Streams at original quality, the default on your home network.',
      ],
    }

    it("leaves the popover as it was while the server doesn't know", () => {
      const { open, popover } = render()
      open()
      expect(said(popover()!)).toEqual(AT_HOME)
    })

    it('leaves them at home', () => {
      const { button, glyph, open, popover } = render()
      act(() => awayFromHome.setWhereabouts('home'))
      expect(button().getAttribute('aria-label')).toBe('Home network · original')
      expect(glyph()).toBe(home)
      open()
      expect(said(popover()!)).toEqual(AT_HOME)
    })

    it('says away from home with the globe while the answer is away, and goes back at home', () => {
      const { button, glyph, open, popover } = render()
      act(() => awayFromHome.setWhereabouts('away'))
      expect(button().getAttribute('aria-label')).toBe('Away from home · original')
      expect(glyph()).toBe(globe)
      open()
      expect(said(popover()!)).toEqual({
        heading: 'Away from home',
        sentences: [
          'Connected to musicbox over Tailscale, from outside your home network.',
          '127.0.0.1:8899',
          'Streams at original quality, the same as at home.',
        ],
      })
      // The popover follows the answer while it's open.
      act(() => awayFromHome.setWhereabouts('home'))
      expect(said(popover()!)).toEqual(AT_HOME)
      act(() => awayFromHome.setWhereabouts('away'))
      act(() => button().click())

      // It follows the answer, not the trip: once the path goes idle or
      // through DERP the server can't tell, and the indicator says what it
      // said before #495.
      act(() => awayFromHome.setWhereabouts('unknown'))
      expect(button().getAttribute('aria-label')).toBe('Home network · original')
      act(() => awayFromHome.setWhereabouts('home'))
      expect(button().getAttribute('aria-label')).toBe('Home network · original')
      expect(glyph()).toBe(home)
    })

    it("names standard while away's quality beside it, with its own reason", () => {
      act(() => awayFromHome.setQuality('standard'))
      const { button, open, popover } = render()
      act(() => awayFromHome.setWhereabouts('away'))
      // jsdom can't play Opus, so standard is the AAC rung, as in Safari.
      expect(button().getAttribute('aria-label')).toBe('Away from home · AAC 160 kbps')
      open()
      expect(popover()!.textContent).toContain('Streams as AAC at 160 kbps, while this device is away from home, as set in Settings.')
    })
  })

  it("says when this device never uses the relay, and opens Settings", () => {
    const onOpenSettings = vi.fn()
    localStorage.setItem('legato:never-relay', 'true')
    const { open, popover } = render({ onOpenSettings })
    open()
    expect(popover()!.textContent).toContain("This device never uses legato.fm's relay.")
    const settings = [...popover()!.querySelectorAll('button')].find((b) => b.textContent === 'settings')!
    act(() => settings.click())
    expect(onOpenSettings).toHaveBeenCalledOnce()
    expect(popover()).toBeNull()
  })
})
