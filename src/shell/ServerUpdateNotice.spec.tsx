// @vitest-environment jsdom
// Issues #110 and #405: the update pill names the server it's for, hangs
// under the capsule, and can be dismissed per release on this device.
// #193's out-of-date notice can't.
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerVersion } from '../hooks/useServerReady'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The id a server writes into the page it serves (serverHost.ts), the only
// one the pill can name a server by when it gave no name.
const page = vi.hoisted(() => ({ servedServerId: null as string | null }))
vi.mock('../config/serverHost', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config/serverHost')>()),
  get SERVED_SERVER_ID() {
    return page.servedServerId
  },
}))

import { Capsule } from './Capsule'
import { ShellLayoutContext, computeShellLayout } from './layout'
import { ServerUpdateNotice, UpdateOfferProvider } from './ServerUpdateNotice'

const roots: Root[] = []

beforeEach(() => {
  localStorage.clear()
  page.servedServerId = null
  // jsdom has neither; Tabs measures its thumb and asks about reduced motion.
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

function serverOffering(latestVersion: string | null, extra: Partial<ServerVersion> = {}): ServerVersion {
  return {
    version: '0.0.9',
    gitSha: 'e7fb903',
    schemaVersion: 44,
    outOfDate: false,
    update: latestVersion ? { latestVersion, action: { kind: 'command', command: 'legato update' } } : null,
    ...extra,
  }
}

function mount(tree: (server: ServerVersion | null) => ReactNode, server: ServerVersion | null, name: string | null) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  const draw = (next: ServerVersion | null) =>
    act(() => root.render(createElement(UpdateOfferProvider, { server: next, name }, tree(next))))
  draw(server)
  const status = () => container.querySelector<HTMLElement>('[role="status"]')
  const dismiss = () => container.querySelector<HTMLButtonElement>('button[aria-label="Dismiss until a newer release"]')
  return { status, dismiss, rerender: draw }
}

// The desktop shell's capsule, which the pill hangs under.
const layout = computeShellLayout(1440, 900, { leftOpen: true, rightOpen: false })
function renderShell(server: ServerVersion | null, name: string | null = 'raspberrypi', { searchOpen = false } = {}) {
  return mount(
    () =>
      createElement(
        ShellLayoutContext.Provider,
        { value: layout },
        createElement(Capsule, { view: 'map', onViewChange: () => undefined, onOpenSearch: () => undefined, hidden: searchOpen }),
      ),
    server,
    name,
  )
}

// What App.tsx mounts over every layout, the phone's included.
function renderApp(server: ServerVersion | null) {
  return mount((next) => createElement(ServerUpdateNotice, { server: next }), server, 'raspberrypi')
}

describe('the update pill', () => {
  it('names the server the release is for, and what to run there', () => {
    const { status } = renderShell(serverOffering('0.1.0'))
    expect(status()?.textContent).toBe('legato-server 0.1.0 is available for raspberrypi — run legato update')
  })

  it("goes by the server's short id when it gave no name", () => {
    page.servedServerId = '2a6e046b-5c1d-4f7e-9a8b-0c1d2e3f4a5b'
    const { status } = renderShell(serverOffering('0.1.0'), null)
    expect(status()?.textContent).toContain('legato-server 0.1.0 is available for 2a6e046b…')
    expect(status()?.querySelector('.mono')?.textContent).toBe('2a6e046b…')
  })

  it('goes by the address when the page knows no id either', () => {
    const { status } = renderShell(serverOffering('0.1.0'), null)
    expect(status()?.textContent).toContain('legato-server 0.1.0 is available for 127.0.0.1')
  })

  it("hangs under the capsule, on the capsule's axis, rather than over it", () => {
    const { status } = renderShell(serverOffering('0.1.0'))
    expect(status()?.className).toContain('top-[calc(var(--inset)+var(--capsule-height)+var(--spacing-sm))]')
    expect(status()?.style.left).toBe(`${layout.capsuleCx}px`)
    expect(status()?.style.maxWidth).toBe(`${layout.paletteWidth}px`)
  })

  it('wraps rather than leave the window when the capsule sits near its edge', () => {
    // 956 wide with the left panel open: the capsule centres 280px from the
    // right edge, so the pill gets the 536px around that centre.
    const narrow = computeShellLayout(956, 900, { leftOpen: true, rightOpen: false })
    const { status } = mount(
      () =>
        createElement(
          ShellLayoutContext.Provider,
          { value: narrow },
          createElement(Capsule, { view: 'map', onViewChange: () => undefined, onOpenSearch: () => undefined, hidden: false }),
        ),
      serverOffering('0.1.0'),
      'raspberrypi',
    )
    expect(status()?.style.left).toBe(`${narrow.capsuleCx}px`)
    expect(status()?.style.maxWidth).toBe(`${2 * (956 - narrow.capsuleCx - 12)}px`)
  })

  it('gets out of the way while search is open, as the capsule does', () => {
    const { status } = renderShell(serverOffering('0.1.0'), 'raspberrypi', { searchOpen: true })
    expect(status()?.className).toContain('opacity-0')
    expect(status()?.className).toContain('pointer-events-none')
  })

  it('stays dismissed for that release on this device, and shows a newer one', () => {
    const { status, dismiss } = renderShell(serverOffering('0.1.0'))
    act(() => dismiss()!.click())
    expect(status()).toBeNull()

    // A reload, still offered 0.1.0.
    const again = renderShell(serverOffering('0.1.0'))
    expect(again.status()).toBeNull()

    again.rerender(serverOffering('0.2.0'))
    expect(again.status()?.textContent).toContain('legato-server 0.2.0 is available for raspberrypi')
  })

  it("isn't drawn over the map by App.tsx's notice, which the phone layout also gets", () => {
    const { status } = renderApp(serverOffering('0.1.0'))
    expect(status()).toBeNull()
  })
})

describe('the out-of-date notice (#193)', () => {
  it("can't be dismissed, whatever was dismissed before", () => {
    const { dismiss: dismissUpdate } = renderShell(serverOffering('0.1.0'))
    act(() => dismissUpdate()!.click())

    const { status, dismiss } = renderApp(serverOffering('0.1.0', { schemaVersion: 20, outOfDate: true }))
    expect(status()?.textContent).toBe('legato-server on 127.0.0.1 (0.0.9, e7fb903) is out of date — update the server')
    expect(status()?.className).toContain('pointer-events-none')
    expect(dismiss()).toBeNull()
    expect(status()?.querySelector('button')).toBeNull()
  })

  it('wins over an update the server also offers', () => {
    const shell = renderShell(serverOffering('0.1.0', { schemaVersion: 20, outOfDate: true }))
    expect(shell.status()).toBeNull()
    const app = renderApp(serverOffering('0.1.0', { schemaVersion: 20, outOfDate: true }))
    expect(app.status()?.textContent).toContain('is out of date — update the server')
  })
})
