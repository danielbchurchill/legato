// @vitest-environment jsdom
//
// #282: switching themes left the map one theme behind. The canvas re-reads
// the colour tokens in an effect keyed on the theme, and React runs a child's
// effects before its parent's, so it read them before useTheme's own effect
// (up in MainApp) had moved data-theme. A second useTheme() in OwnerGated
// held its own copy of the preference, which a change in Settings never
// reached. And a first launch with nothing stored followed the system; it
// starts in ink now, in index.html's boot script as well as here.
import { act, useEffect, useLayoutEffect, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import indexHtml from '../../index.html?raw'

type Theme = ReturnType<typeof import('./useTheme').useTheme>
type Result = { current: Theme | null }

let systemLight = false
const mediaListeners = new Set<() => void>()

function matchMedia(query: string) {
  return {
    media: query,
    get matches() {
      return query === '(prefers-color-scheme: light)' && systemLight
    },
    addEventListener: (_type: string, listener: () => void) => mediaListeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => mediaListeners.delete(listener),
  }
}

function setSystemLight(light: boolean) {
  systemLight = light
  for (const listener of [...mediaListeners]) listener()
}

// The store lives at module level, so each test loads a fresh copy, the way
// a page load would.
async function loadUseTheme() {
  vi.resetModules()
  return (await import('./useTheme')).useTheme
}

let root: Root | null = null

async function render(node: ReactNode) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root!.render(node))
}

async function mountTheme(): Promise<() => Theme> {
  const useTheme = await loadUseTheme()
  const result: Result = { current: null }
  function Probe() {
    result.current = useTheme()
    return null
  }
  await render(<Probe />)
  return () => result.current!
}

beforeEach(() => {
  systemLight = false
  vi.stubGlobal('matchMedia', matchMedia)
  const meta = document.createElement('meta')
  meta.name = 'theme-color'
  document.head.appendChild(meta)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  mediaListeners.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
  delete document.documentElement.dataset.theme
  document.head.innerHTML = ''
  document.body.innerHTML = ''
})

describe('switching theme', () => {
  it('moves data-theme before any effect below it re-reads the tokens', async () => {
    localStorage.setItem('legato:theme', 'dark')
    const useTheme = await loadUseTheme()
    const seen: string[] = []
    const theme: Result = { current: null }

    // What the map does: re-resolve its palette when the theme prop changes.
    function Map({ resolved }: { resolved: string }) {
      useLayoutEffect(() => {
        seen.push(`layout ${resolved}: ${document.documentElement.dataset.theme}`)
      }, [resolved])
      useEffect(() => {
        seen.push(`effect ${resolved}: ${document.documentElement.dataset.theme}`)
      }, [resolved])
      return null
    }
    function App() {
      theme.current = useTheme()
      return <Map resolved={theme.current.resolvedTheme} />
    }

    await render(<App />)
    seen.length = 0
    await act(async () => theme.current!.setPreference('light'))
    await act(async () => theme.current!.setPreference('dark'))

    expect(seen).toEqual(['layout light: light', 'effect light: light', 'layout dark: dark', 'effect dark: dark'])
  })

  it('keeps a second useTheme() on the preference Settings picked', async () => {
    localStorage.setItem('legato:theme', 'system')
    const useTheme = await loadUseTheme()
    const gate: Result = { current: null }
    const main: Result = { current: null }

    // OwnerGated wraps MainApp, and each calls the hook.
    function Main() {
      main.current = useTheme()
      return null
    }
    function Gate({ children }: { children: ReactNode }) {
      gate.current = useTheme()
      return children
    }

    await render(
      <Gate>
        <Main />
      </Gate>,
    )
    await act(async () => main.current!.setPreference('light'))
    expect(gate.current!.preference).toBe('light')

    // An OS theme change used to send the gate's stale 'system' copy back
    // through its own effect, putting data-theme back to dark.
    await act(async () => setSystemLight(true))
    await act(async () => setSystemLight(false))
    expect(gate.current!.resolvedTheme).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('stores the choice for the next launch', async () => {
    const theme = await mountTheme()
    await act(async () => theme().setPreference('light'))
    expect(localStorage.getItem('legato:theme')).toBe('light')
  })

  it('follows the system live once system is picked', async () => {
    const theme = await mountTheme()
    await act(async () => theme().setPreference('system'))
    expect(document.documentElement.dataset.theme).toBe('dark')
    await act(async () => setSystemLight(true))
    expect(theme().resolvedTheme).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
  })
})

describe('first launch', () => {
  it('starts in ink with nothing stored, even when the system prefers light', async () => {
    systemLight = true
    const theme = await mountTheme()
    expect(theme().preference).toBe('dark')
    expect(theme().resolvedTheme).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  it('starts in ink when storage is unavailable', async () => {
    systemLight = true
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    const theme = await mountTheme()
    expect(theme().resolvedTheme).toBe('dark')
  })

  it.each([
    ['dark', false, 'dark'],
    ['dark', true, 'dark'],
    ['light', false, 'light'],
    ['system', false, 'dark'],
    ['system', true, 'light'],
  ] as const)('keeps a stored %s (system light: %s) as %s', async (stored, light, expected) => {
    systemLight = light
    localStorage.setItem('legato:theme', stored)
    const theme = await mountTheme()
    expect(theme().preference).toBe(stored)
    expect(theme().resolvedTheme).toBe(expected)
  })
})

describe("index.html's boot script", () => {
  const bootScript = indexHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? ''

  // The script runs before the stylesheet paints anything, and useTheme takes
  // over once React mounts; if they disagree, the first paint is the other theme.
  const cases: [stored: string | null, light: boolean][] = []
  for (const stored of [null, 'dark', 'light', 'system', 'something else']) {
    for (const light of [false, true]) cases.push([stored, light])
  }

  it('is the inline script that reads the stored theme', () => {
    expect(bootScript).toContain("localStorage.getItem('legato:theme')")
  })

  it.each(cases)('agrees with useTheme when %s is stored (system light: %s)', async (stored, light) => {
    systemLight = light
    if (stored !== null) localStorage.setItem('legato:theme', stored)
    new Function(bootScript)()
    const booted = document.documentElement.dataset.theme
    delete document.documentElement.dataset.theme

    const theme = await mountTheme()
    expect(booted).toBe(theme().resolvedTheme)
  })

  it('agrees with useTheme when storage is unavailable', async () => {
    systemLight = true
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    new Function(bootScript)()
    const booted = document.documentElement.dataset.theme
    delete document.documentElement.dataset.theme

    const theme = await mountTheme()
    expect(booted).toBe(theme().resolvedTheme)
  })

  it('starts a first launch in ink', () => {
    systemLight = true
    new Function(bootScript)()
    expect(document.documentElement.dataset.theme).toBe('dark')
  })
})
