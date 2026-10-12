// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PHONE_MAX_WIDTH, phonePlatform, phoneShellLayout, usePhoneLayout } from './phoneLayout'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()))
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

/* A matchMedia whose answer the test sets, and which tells its listeners
 * when it changes, as a browser does when the window crosses the width. */
function fakeMatchMedia(initial: boolean) {
  let matches = initial
  const listeners = new Set<() => void>()
  const queries: string[] = []
  vi.stubGlobal('matchMedia', (query: string) => {
    queries.push(query)
    return {
      get matches() {
        return matches
      },
      media: query,
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    }
  })
  return {
    queries,
    listeners,
    set(next: boolean) {
      matches = next
      for (const listener of listeners) listener()
    },
  }
}

function renderProbe() {
  const seen: boolean[] = []
  function Probe() {
    seen.push(usePhoneLayout())
    return null
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(createElement(Probe)))
  return seen
}

describe('usePhoneLayout', () => {
  it('asks for the phone width, 600px or narrower', () => {
    const media = fakeMatchMedia(true)
    const seen = renderProbe()
    expect(PHONE_MAX_WIDTH).toBe(600)
    expect(media.queries).toContain('(max-width: 600px)')
    expect(seen.at(-1)).toBe(true)
  })

  it('follows the viewport across the width, and stops listening when unmounted', () => {
    const media = fakeMatchMedia(false)
    const seen = renderProbe()
    expect(seen.at(-1)).toBe(false)
    act(() => media.set(true))
    expect(seen.at(-1)).toBe(true)
    act(() => media.set(false))
    expect(seen.at(-1)).toBe(false)
    act(() => roots.splice(0).forEach((root) => root.unmount()))
    expect(media.listeners.size).toBe(0)
  })

  it('is the desktop where there is no matchMedia', () => {
    vi.stubGlobal('matchMedia', undefined)
    expect(renderProbe().at(-1)).toBe(false)
  })
})

describe('phonePlatform', () => {
  it('reads Android from its user agent', () => {
    expect(
      phonePlatform(
        'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36',
      ),
    ).toBe('android')
  })

  it('gives everything else iOS, a narrowed desktop browser included', () => {
    expect(
      phonePlatform(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('ios')
    expect(phonePlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/154.0.0.0 Safari/537.36')).toBe('ios')
  })
})

describe('phoneShellLayout', () => {
  it('leaves the whole width free and keeps the map clear of the sheet at peek', () => {
    const layout = phoneShellLayout(390, 844, 205)
    expect(layout.leftOccupancy).toBe(0)
    expect(layout.rightOccupancy).toBe(0)
    expect(layout.free).toBe(390)
    expect(layout.cx).toBe(195)
    expect(layout.floatingBottom).toBe(205)
    // The search palette opens across the phone, 12px in from each side.
    expect(layout.paletteWidth).toBe(366)
    expect(layout.paletteCx).toBe(195)
  })
})
