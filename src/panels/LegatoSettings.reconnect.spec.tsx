// @vitest-environment jsdom
//
// Issue #119, the coordinator's second review of #346: the library folders'
// scan rows after the server restarts. The restart paused the run it
// interrupted, or a run finished while its events had nowhere to go, and
// the row kept the last progress with pause and cancel buttons for a job
// that no longer runs.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false, invoke: vi.fn() }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }))

import { announceServerBack } from '../connect/reconnect'
import { ToastProvider } from '../ui/Toast'
import { LegatoSettings } from './LegatoSettings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Every socket the panel opens, so a test can send it the server's events.
class FakeSocket {
  static made: FakeSocket[] = []
  readyState = 1
  onopen: (() => void) | null = null
  onmessage: ((msg: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  constructor() {
    FakeSocket.made.push(this)
  }
  close() {}
  static send(event: string, payload: unknown) {
    for (const socket of FakeSocket.made) socket.onmessage?.({ data: JSON.stringify({ event, payload }) })
  }
}

const ROOT = { id: 1, path: '/music', label: 'Music', enabled: 1, watch_status: 'watching', watch_reason: null }
const PROGRESS = {
  jobId: 5,
  libraryRootId: 1,
  stage: 'read_tags',
  stageDone: 120,
  stageTotal: 700,
  filesScanned: 120,
  filesTotal: 700,
  filesAdded: 120,
  filesUpdated: 0,
  rate: 40,
  etaSeconds: 15,
}

describe('LegatoSettings after the server comes back', () => {
  let root: Root | null = null
  let container: HTMLDivElement
  // What /scan-jobs says once the server is back.
  let jobs: { id: number; status: string }[] = []

  beforeEach(() => {
    FakeSocket.made = []
    jobs = []
    vi.stubGlobal('WebSocket', FakeSocket)
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    )
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }))
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname.replace('/api/v1', '')
        const body = path === '/library-roots' ? [ROOT] : path === '/scan-jobs' ? jobs : path === '/auth/me' ? { user: null } : {}
        return { ok: true, status: 200, json: async () => body } as Response
      }),
    )
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    container.remove()
    vi.unstubAllGlobals()
  })

  const settle = () =>
    act(async () => {
      for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0))
    })

  async function mountScanning() {
    await act(async () => {
      root = createRoot(container)
      root.render(
        createElement(
          ToastProvider,
          null,
          createElement(LegatoSettings, {
            settings: {},
            updateSettings: async () => undefined,
            onSetAudioDevice: async () => undefined,
            themePreference: 'system',
            onSetThemePreference: () => undefined,
          }),
        ),
      )
    })
    await settle()
    await act(async () => FakeSocket.send('scan:progress', PROGRESS))
    expect(button('Pause scanning Music')).not.toBeNull()
  }

  const button = (label: string) => container.querySelector(`[aria-label="${label}"]`)

  it('shows a run the restart paused as paused, with its resume button', async () => {
    await mountScanning()
    jobs = [{ id: 5, status: 'paused' }]
    await act(async () => announceServerBack({ restarted: true }))
    await settle()

    expect(button('Pause scanning Music')).toBeNull()
    expect(button('Resume scanning Music')).not.toBeNull()
  })

  it('drops a run that finished while its events had nowhere to go', async () => {
    await mountScanning()
    jobs = [{ id: 5, status: 'done' }]
    await act(async () => announceServerBack({ restarted: true }))
    await settle()

    expect(button('Pause scanning Music')).toBeNull()
    expect(button('Resume scanning Music')).toBeNull()
    expect(button('Cancel scanning Music')).toBeNull()
  })

  it('keeps a run that is still going', async () => {
    await mountScanning()
    jobs = [{ id: 5, status: 'running' }]
    await act(async () => announceServerBack({ restarted: true }))
    await settle()

    expect(button('Pause scanning Music')).not.toBeNull()
  })
})
