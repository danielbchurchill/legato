// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountContext } from '../auth/accountContext'
import { OPEN_CONNECT_EVENT } from '../connect/openConnect'
import { neverUseRelay } from '../connect/connectionPath'
import type { ServerVersion } from '../hooks/useServerReady'
import { readQualityPreference } from '../playback/quality'
import { UpdateOfferProvider } from '../shell/ServerUpdateNotice'
import { ToastProvider } from '../ui/Toast'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const auth = vi.hoisted(() => ({ signOut: vi.fn(async () => undefined) }))
vi.mock('../auth/useAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../auth/useAuth')>()),
  signOut: auth.signOut,
}))
// The legato.fm group is the desktop's own, with its own specs; here it
// would only talk to legato.fm.
vi.mock('../panels/LegatoAccountRow', () => ({ LegatoAccountRow: () => null }))

import { SettingsPage } from './SettingsPage'

const roots: Root[] = []
const requests: { method: string; path: string }[] = []

beforeEach(() => {
  localStorage.clear()
  history.replaceState(null, '')
  requests.length = 0
  auth.signOut.mockClear()
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })),
  )
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  vi.stubGlobal(
    'WebSocket',
    class {
      static CLOSED = 3
      readyState = 0
      close() {}
    },
  )
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const { pathname, search } = new URL(url)
      const path = pathname.replace('/api/v1', '') + search
      requests.push({ method: init?.method ?? 'GET', path })
      const body =
        path === '/stats'
          ? { artists: 3, albums: 4, tracks: 20, totalBytes: 0, totalDurationMs: 0 }
          : path === '/hygiene/worklist'
            ? [{ type: 'missing_file', fileId: 1, filePath: '/a.flac', nodeId: 2, nodeTitle: 'A', missingSince: '' }]
            : path === '/tag-manager?field=unmatched'
              ? [{ id: 1, title: 'T', artist: null }]
              : []
      return { ok: true, status: 200, json: async () => body } as Response
    }),
  )
})

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()))
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

async function render(settings: Record<string, string> = {}, server: ServerVersion | null = null) {
  const updateSettings = vi.fn(async () => undefined)
  const onSetThemePreference = vi.fn()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () =>
    root.render(
      createElement(
        ToastProvider,
        null,
        createElement(
          UpdateOfferProvider,
          { server, name: 'raspberrypi' },
          createElement(
            AccountContext.Provider,
            { value: { role: 'owner', provider: 'local', displayName: 'Sam Rivera', email: null } },
            createElement(SettingsPage, { settings, updateSettings, themePreference: 'dark', onSetThemePreference }),
          ),
        ),
      ),
    ),
  )
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
  return { container, updateSettings, onSetThemePreference }
}

const row = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(text)) ?? null
const switchNamed = (container: HTMLElement, name: string) =>
  container.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${name}"]`)

describe('Settings on the phone', () => {
  it('chooses the theme, for this device', async () => {
    const { container, onSetThemePreference } = await render()
    const tabs = [...container.querySelectorAll('[role="tab"]')]
    expect(tabs.map((t) => t.textContent)).toEqual(['ink', 'paper', 'system'])
    expect(tabs[0].getAttribute('aria-selected')).toBe('true')
    act(() => (tabs[1] as HTMLButtonElement).click())
    expect(onSetThemePreference).toHaveBeenCalledWith('light')
  })

  it('names the server it uses and its size, and opens the connect screen to change it', async () => {
    const { container } = await render()
    expect(container.textContent).toContain('20 tracks')
    const opened = vi.fn()
    window.addEventListener(OPEN_CONNECT_EVENT, opened)
    act(() => row(container, 'Change server')!.click())
    window.removeEventListener(OPEN_CONNECT_EVENT, opened)
    expect(opened).toHaveBeenCalledOnce()
  })

  it("shows Library health's state and pushes it", async () => {
    const { container } = await render()
    const health = row(container, 'Library health')!
    // A missing file and an unmatched track: two kinds, the worse one bad.
    expect(health.textContent).toContain('2 issues')
    expect(health.querySelector('.bg-\\[var\\(--color-bad\\)\\]')).not.toBeNull()
    act(() => health.click())
    expect((history.state as { legatoPhonePages: string[] }).legatoPhonePages).toEqual(['health'])
  })

  it('picks the stream quality from a native select, stored on this device', async () => {
    const { container } = await render()
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Stream quality"]')!
    expect(select.value).toBe('auto')
    act(() => {
      select.value = 'standard'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(readQualityPreference()).toBe('standard')
    expect(container.textContent).toContain('standard · 160 kbps')
  })

  it("turns this device's never use legato.fm on and off", async () => {
    const { container } = await render()
    const toggle = switchNamed(container, "Never connect through legato.fm's relay on this device")!
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    act(() => toggle.click())
    expect(neverUseRelay()).toBe(true)
    expect(toggle.getAttribute('aria-checked')).toBe('true')
  })

  it('saves reduce motion and online lookups to the account, from what they are now', async () => {
    const { container, updateSettings } = await render({ enrichmentEnabled: 'false' })
    const motion = switchNamed(container, 'Reduce motion, whatever the system setting')!
    const lookup = switchNamed(container, 'Look up MusicBrainz metadata and cover art automatically')!
    expect(motion.getAttribute('aria-checked')).toBe('false')
    expect(lookup.getAttribute('aria-checked')).toBe('false')
    act(() => motion.click())
    act(() => lookup.click())
    expect(updateSettings).toHaveBeenCalledWith({ reducedMotionForced: 'true' })
    expect(updateSettings).toHaveBeenCalledWith({ enrichmentEnabled: 'true' })
  })

  it('draws its switches at the phone size, each a 44px target', async () => {
    const { container } = await render()
    for (const toggle of container.querySelectorAll('[role="switch"]')) {
      expect(toggle.className).toContain('touch-target')
      expect(toggle.querySelector('.focus-ring-part')?.className).toContain('w-[51px]')
    }
  })

  it('asks before rebuilding the map, then rebuilds it', async () => {
    const { container } = await render()
    act(() => row(container, 'Rebuild map layout')!.click())
    const confirm = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Rebuild')!
    expect(confirm).toBeDefined()
    await act(async () => confirm.click())
    expect(requests).toContainEqual({ method: 'POST', path: '/layout/rebuild' })
  })

  it("says the server has a newer release, without the command the phone can't run", async () => {
    const offering = (latestVersion: string): ServerVersion => ({
      version: '0.0.9',
      gitSha: 'e7fb903',
      schemaVersion: 44,
      outOfDate: false,
      update: { latestVersion, action: { kind: 'command', command: 'legato update' } },
    })
    const { container } = await render({}, offering('0.1.0'))
    const library = [...container.querySelectorAll('section')].find((s) => s.querySelector('h3')?.textContent === 'library')!
    expect(library.textContent).toContain('legato-server 0.1.0 is available for raspberrypi')
    expect(container.textContent).not.toContain('legato update')

    const dismiss = container.querySelector<HTMLButtonElement>('button[aria-label="Dismiss until a newer release"]')!
    expect(dismiss.style.width).toBe('44px')
    act(() => dismiss.click())
    expect(container.textContent).not.toContain('is available')

    // Dismissed on this device for 0.1.0 only.
    const again = await render({}, offering('0.1.0'))
    expect(again.container.textContent).not.toContain('is available')
    const newer = await render({}, offering('0.2.0'))
    expect(newer.container.textContent).toContain('legato-server 0.2.0 is available for raspberrypi')
  })

  it('has no update row when the server offers none', async () => {
    const { container } = await render()
    expect(container.textContent).not.toContain('is available')
    expect(container.querySelector('button[aria-label="Dismiss until a newer release"]')).toBeNull()
  })

  it('names who is signed in, and signs out', async () => {
    const { container } = await render()
    expect(container.textContent).toContain('Sam Rivera')
    expect(container.textContent).toContain("this server's owner")
    act(() => row(container, 'Sign out')!.click())
    expect(auth.signOut).toHaveBeenCalledOnce()
  })

  it("leaves out what a phone can't use and what has nothing behind it", async () => {
    const { container } = await render()
    for (const absent of [
      'Output',
      'Volume levelling',
      'Focus on hover',
      'shortcuts',
      'serving',
      'add folder',
      'Gapless',
      'Crossfade',
      'cellular',
    ]) {
      expect(container.textContent).not.toContain(absent)
    }
  })
})
