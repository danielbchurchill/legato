// @vitest-environment jsdom
// Issues #110 and #405: the update notice names the server it's for, and
// can be dismissed per release on this device. #193's out-of-date notice
// can't.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerVersion } from '../hooks/useServerReady'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The id a server writes into the page it serves (serverHost.ts), the only
// one this notice can name a server by when it gave no name.
const page = vi.hoisted(() => ({ servedServerId: null as string | null }))
vi.mock('../config/serverHost', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config/serverHost')>()),
  get SERVED_SERVER_ID() {
    return page.servedServerId
  },
}))

import { ServerUpdateNotice } from './ServerUpdateNotice'
import { UpdateOfferProvider } from './serverUpdate'

const roots: Root[] = []

function stubWidth(phone: boolean) {
  // The phone layout's query, and the tooltip's reduced-motion one.
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: phone, addEventListener: () => undefined, removeEventListener: () => undefined })),
  )
}

beforeEach(() => {
  localStorage.clear()
  page.servedServerId = null
  stubWidth(false)
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

function render(server: ServerVersion | null, name: string | null = 'raspberrypi') {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  const draw = (next: ServerVersion | null) =>
    act(() => root.render(createElement(UpdateOfferProvider, { server: next, name }, createElement(ServerUpdateNotice, { server: next }))))
  draw(server)
  const notice = () => container.querySelector<HTMLElement>('[role="status"]')
  const dismiss = () => container.querySelector<HTMLButtonElement>('button[aria-label="Dismiss until a newer release"]')
  return { notice, dismiss, rerender: draw }
}

describe('the update notice', () => {
  it('names the server the release is for, and what to run there', () => {
    const { notice } = render(serverOffering('0.1.0'))
    expect(notice()?.textContent).toBe('legato-server 0.1.0 is available for raspberrypi — run legato update')
  })

  it("goes by the server's short id when it gave no name", () => {
    page.servedServerId = '2a6e046b-5c1d-4f7e-9a8b-0c1d2e3f4a5b'
    const { notice } = render(serverOffering('0.1.0'), null)
    expect(notice()?.textContent).toContain('legato-server 0.1.0 is available for 2a6e046b…')
    expect(notice()?.querySelector('.mono')?.textContent).toBe('2a6e046b…')
  })

  it('goes by the address when the page knows no id either', () => {
    const { notice } = render(serverOffering('0.1.0'), null)
    expect(notice()?.textContent).toContain('legato-server 0.1.0 is available for 127.0.0.1')
  })

  it('stays dismissed for that release on this device, and shows a newer one', () => {
    const { notice, dismiss } = render(serverOffering('0.1.0'))
    act(() => dismiss()!.click())
    expect(notice()).toBeNull()

    // A reload, still offered 0.1.0.
    const again = render(serverOffering('0.1.0'))
    expect(again.notice()).toBeNull()

    again.rerender(serverOffering('0.2.0'))
    expect(again.notice()?.textContent).toContain('legato-server 0.2.0 is available for raspberrypi')
  })

  it("isn't drawn over the map on the phone layout, where Settings has it", () => {
    stubWidth(true)
    const { notice } = render(serverOffering('0.1.0'))
    expect(notice()).toBeNull()
  })
})

describe('the out-of-date notice (#193)', () => {
  it("can't be dismissed, whatever was dismissed before", () => {
    const { dismiss: dismissUpdate } = render(serverOffering('0.1.0'))
    act(() => dismissUpdate()!.click())

    const { notice, dismiss } = render(serverOffering('0.1.0', { schemaVersion: 20, outOfDate: true }))
    expect(notice()?.textContent).toBe('legato-server on 127.0.0.1 (0.0.9, e7fb903) is out of date — update the server')
    expect(notice()?.className).toContain('pointer-events-none')
    expect(dismiss()).toBeNull()
    expect(notice()?.querySelector('button')).toBeNull()
  })

  it('stays put on the phone layout', () => {
    stubWidth(true)
    const { notice } = render(serverOffering(null, { schemaVersion: 20, outOfDate: true }))
    expect(notice()?.textContent).toContain('is out of date — update the server')
  })
})
