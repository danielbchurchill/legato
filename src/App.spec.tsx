// @vitest-environment jsdom
//
// Issue #119, and the coordinator's review of #346: how App holds the
// workspace, the connect screen and the unreachable state together while
// the server comes and goes. useServerReady is replaced by a status the
// test sets, and the map, the player and the connect screen by stand-ins,
// so what's left is App's own wiring.
import { act, createElement, forwardRef, useState, useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Outage, ServerStatus } from './hooks/useServerReady'
import { MIN_SERVER_SCHEMA_VERSION } from './config/serverVersion'

const harness = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  return {
    status: null as unknown as ServerStatus,
    listeners,
    railRenders: 0,
    connectMounts: 0,
    set(patch: Partial<ServerStatus>) {
      harness.status = { ...harness.status, ...patch }
      for (const listener of listeners) listener()
    },
  }
})

vi.mock('./hooks/useServerReady', () => ({
  useServerReady: () =>
    useSyncExternalStore(
      (listener) => {
        harness.listeners.add(listener)
        return () => harness.listeners.delete(listener)
      },
      () => harness.status,
    ),
}))

vi.mock('./canvas/Canvas', () => ({ default: forwardRef(() => null) }))

vi.mock('./shell/Rail', () => ({
  Rail: () => {
    harness.railRenders++
    return null
  },
}))

vi.mock('./search/SearchPalette', () => ({ SearchPalette: () => createElement('div', { 'data-testid': 'search' }) }))

// Counts its mounts, and keeps what was typed in its own state, as the real
// one's address field does.
vi.mock('./connect/ConnectScreen', async () => {
  const { useEffect: useMountEffect } = await import('react')
  return {
    ConnectScreen: () => {
      const [typed, setTyped] = useState('')
      useMountEffect(() => {
        harness.connectMounts++
      }, [])
      return createElement('input', { 'aria-label': 'Server address', value: typed, onChange: (e: { target: { value: string } }) => setTyped(e.target.value) })
    },
  }
})

vi.mock('./playback/usePlayback', () => {
  const playback = new Proxy(
    {
      currentTitle: null,
      status: { playing: false, positionMs: 0, currentRecordingNodeId: null, currentFileId: null, currentDurationMs: null, volume: 1 },
      queueBusy: false,
      shuffled: false,
      problem: null,
      upNext: [],
    } as Record<string | symbol, unknown>,
    { get: (target, key) => (key in target ? target[key] : vi.fn(async () => undefined)) },
  )
  return { usePlayback: () => playback }
})

import App from './App'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SIGNED_IN = {
  ownerExists: true,
  setupCodeRequired: false,
  user: { role: 'owner', provider: 'password', displayName: 'Dan', email: null },
  oauth: { google: false, github: false },
}

// What the fake server answers for library-roots.
let libraryRoots: { status: number; body: unknown } = { status: 200, body: [{ id: 1, path: '/music' }] }

function json(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

function asleep(overrides: Partial<Outage> = {}): Outage {
  return {
    since: Date.now(),
    failure: { kind: 'no-answer' },
    lastSeenAt: Date.now() - 60_000,
    networkChangedAt: null,
    deviceOnline: true,
    triedAt: null,
    ...overrides,
  }
}

describe('App across an outage', () => {
  let root: Root | null = null
  let container: HTMLDivElement

  beforeEach(() => {
    harness.railRenders = 0
    harness.connectMounts = 0
    harness.status = {
      ready: true,
      everConnected: true,
      server: { version: '0.4.0', gitSha: 'abc1234', schemaVersion: MIN_SERVER_SCHEMA_VERSION, outOfDate: false, update: null },
      name: 'musicbox',
      outage: null,
      retry: () => undefined,
      retrying: false,
    }
    libraryRoots = { status: 200, body: [{ id: 1, path: '/music' }] }
    localStorage.clear()
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }))
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
      vi.fn(async (url: string) => {
        if (url.endsWith('/auth/status')) return json(200, SIGNED_IN)
        if (url.endsWith('/library-roots')) return json(libraryRoots.status, libraryRoots.body)
        if (url.endsWith('/settings')) return json(200, {})
        if (url.endsWith('/nodes') || url.endsWith('/edges') || url.endsWith('/scan-jobs')) return json(200, [])
        return json(200, {})
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

  async function settle() {
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    }
  }

  async function mount() {
    await act(async () => {
      root = createRoot(container)
      root.render(createElement(App))
    })
    await settle()
  }

  async function setStatus(patch: Partial<ServerStatus>) {
    await act(async () => harness.set(patch))
    await settle()
  }

  it("doesn't render the workspace again while an outage goes on unchanged", async () => {
    await mount()
    expect(harness.railRenders).toBeGreaterThan(0)

    await setStatus({ ready: false, outage: asleep() })
    expect(container.textContent).toContain("Can't reach musicbox")
    const renders = harness.railRenders

    // App renders again (a new status object), with nothing in it changed.
    await setStatus({})
    await setStatus({})
    expect(harness.railRenders).toBe(renders)
  })

  // The coordinator's review of #346: a 401 or 500 from library-roots is a
  // JSON object, and it read as a library with no folders.
  it("doesn't take an error from library-roots for an empty library, and asks again", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      libraryRoots = { status: 500, body: { error: 'database is locked' } }
      await act(async () => {
        root = createRoot(container)
        root.render(createElement(App))
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(container.textContent).toContain('loading library…')
      expect(container.textContent).not.toContain('Add your music')

      libraryRoots = { status: 200, body: { roots: 'not a list' } }
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000)
      })
      expect(container.textContent).toContain('loading library…')

      libraryRoots = { status: 200, body: [] }
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000)
      })
      expect(container.textContent).toContain('Add your music')
    } finally {
      vi.useRealTimers()
    }
  })
})
