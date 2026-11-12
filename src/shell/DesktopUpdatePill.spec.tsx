// @vitest-environment jsdom
// Issue #129: the desktop app's own update takes the update pill's place
// under the capsule. It restarts only on a click, links to the release for
// a .deb, and can be dismissed per release on this device.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerVersion } from '../hooks/useServerReady'
import type { DesktopUpdate } from './desktopUpdate'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const shell = vi.hoisted(() => ({
  ready: null as DesktopUpdate | null,
  emit: null as ((update: DesktopUpdate | null) => void) | null,
  restart: vi.fn<() => Promise<void>>(),
}))

vi.mock('../config/runtime', () => ({ IS_TAURI: true }))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn((command: string) => {
    if (command === 'desktop_update') return Promise.resolve(shell.ready)
    if (command === 'desktop_update_restart') return shell.restart()
    return Promise.reject(new Error(`unexpected command ${command}`))
  }),
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((event: string, handler: (e: { payload: DesktopUpdate | null }) => void) => {
    if (event === 'desktop-update://ready') shell.emit = (payload) => handler({ payload })
    return Promise.resolve(() => {
      shell.emit = null
    })
  }),
}))

import { invoke } from '@tauri-apps/api/core'
import { Capsule } from './Capsule'
import { ShellLayoutContext, computeShellLayout } from './layout'
import { UpdateOfferProvider } from './ServerUpdateNotice'

const roots: Root[] = []

beforeEach(() => {
  localStorage.clear()
  shell.ready = null
  shell.emit = null
  shell.restart.mockReset()
  vi.mocked(invoke).mockClear()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })),
  )
})

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()))
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const RESTART: DesktopUpdate = { version: '0.3.0', action: { kind: 'restart' } }
const LINK: DesktopUpdate = {
  version: '0.3.0',
  action: { kind: 'link', url: 'https://github.com/danielbchurchill/legato/releases/tag/v0.3.0' },
}

const layout = computeShellLayout(1440, 900, { leftOpen: true, rightOpen: false })

function serverOffering(latestVersion: string | null): ServerVersion {
  return {
    version: '0.0.9',
    gitSha: 'e7fb903',
    schemaVersion: 44,
    outOfDate: false,
    update: latestVersion ? { latestVersion, action: { kind: 'command', command: 'legato update' } } : null,
  }
}

async function renderShell(server: ServerVersion | null = null) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () =>
    root.render(
      createElement(
        UpdateOfferProvider,
        { server, name: 'raspberrypi' },
        createElement(
          ShellLayoutContext.Provider,
          { value: layout },
          createElement(Capsule, { view: 'map', onViewChange: () => undefined, onOpenSearch: () => undefined, hidden: false }),
        ),
      ),
    ),
  )
  const status = () => container.querySelector<HTMLElement>('[role="status"]')
  const button = (name: string) =>
    [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === name || b.getAttribute('aria-label') === name,
    ) ?? null
  return { status, button }
}

describe("the desktop app's own update", () => {
  it('says nothing until an update is ready', async () => {
    const { status } = await renderShell()
    expect(status()).toBeNull()
  })

  it('shows one found before the page loaded, under the capsule', async () => {
    shell.ready = RESTART
    const { status } = await renderShell()
    expect(status()?.textContent).toBe('Legato 0.3.0 is available — restart to update')
    expect(status()?.className).toContain('top-[calc(var(--inset)+var(--capsule-height)+var(--spacing-sm))]')
    expect(status()?.style.left).toBe(`${layout.capsuleCx}px`)
  })

  it('shows one the background download finishes while the app is open', async () => {
    const { status } = await renderShell()
    act(() => shell.emit!(RESTART))
    expect(status()?.textContent).toBe('Legato 0.3.0 is available — restart to update')
  })

  it('goes when Settings switches the check off and the shell withdraws it (#497)', async () => {
    shell.ready = RESTART
    const { status } = await renderShell()
    expect(status()?.textContent).toBe('Legato 0.3.0 is available — restart to update')
    act(() => shell.emit!(null))
    expect(status()).toBeNull()
  })

  it('restarts only when asked', async () => {
    shell.ready = RESTART
    shell.restart.mockReturnValue(new Promise(() => undefined))
    const { status, button } = await renderShell()
    expect(invoke).not.toHaveBeenCalledWith('desktop_update_restart')

    act(() => button('restart to update')!.click())
    expect(invoke).toHaveBeenCalledWith('desktop_update_restart')
    expect(status()?.textContent).toBe('Legato 0.3.0 is available — restarting…')
    expect(button('restarting…')?.disabled).toBe(true)
  })

  it('links to the release when the update failed to install', async () => {
    shell.ready = RESTART
    shell.restart.mockRejectedValue(new Error("couldn't install"))
    const { status, button } = await renderShell()
    await act(async () => button('restart to update')!.click())
    expect(status()?.textContent).toBe("Legato 0.3.0 didn't install — download the latest release")
    expect(status()?.querySelector('a')?.getAttribute('href')).toBe('https://github.com/danielbchurchill/legato/releases/tag/v0.3.0')
  })

  it('links to the release for a .deb, which its package manager updates', async () => {
    shell.ready = LINK
    const { status, button } = await renderShell()
    expect(status()?.textContent).toBe('Legato 0.3.0 is available — download the latest release')
    expect(status()?.querySelector('a')?.getAttribute('href')).toBe(LINK.action.kind === 'link' ? LINK.action.url : '')
    expect(button('restart to update')).toBeNull()
  })

  it('stays dismissed for that release on this device, and shows a newer one', async () => {
    shell.ready = RESTART
    const first = await renderShell()
    act(() => first.button('Dismiss until a newer release')!.click())
    expect(first.status()).toBeNull()

    const again = await renderShell()
    expect(again.status()).toBeNull()

    act(() => shell.emit!({ version: '0.4.0', action: { kind: 'restart' } }))
    expect(again.status()?.textContent).toBe('Legato 0.4.0 is available — restart to update')
  })

  it("goes before a server's update, which shows once it's dismissed", async () => {
    shell.ready = RESTART
    const { status, button } = await renderShell(serverOffering('0.3.1'))
    expect(status()?.textContent).toBe('Legato 0.3.0 is available — restart to update')

    act(() => button('Dismiss until a newer release')!.click())
    expect(status()?.textContent).toBe('legato-server 0.3.1 is available for raspberrypi — run legato update')
  })
})
