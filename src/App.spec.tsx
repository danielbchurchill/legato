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
    // Mounts of the workspace: a second one means the app was remounted,
    // and the queue and the web player with it.
    railMounts: 0,
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

vi.mock('./shell/Rail', async () => {
  const { useEffect: useMountEffect } = await import('react')
  return {
    Rail: () => {
      harness.railRenders++
      useMountEffect(() => {
        harness.railMounts++
      }, [])
      return null
    },
  }
})

vi.mock('./search/SearchPalette', () => ({ SearchPalette: () => createElement('div', { 'data-testid': 'search' }) }))

// Counts its mounts, and keeps what was typed in its own state, as the real
// one's address field does.
vi.mock('./connect/ConnectScreen', async () => {
  const { useEffect: useMountEffect } = await import('react')
  return {
    ConnectScreen: ({ onClose }: { onClose: () => void }) => {
      const [typed, setTyped] = useState('')
      useMountEffect(() => {
        harness.connectMounts++
      }, [])
      return createElement(
        'div',
        null,
        createElement('input', {
          'aria-label': 'Server address',
          value: typed,
          onChange: (e: { target: { value: string } }) => setTyped(e.target.value),
        }),
        createElement('button', { 'data-testid': 'close-connect', onClick: onClose }, 'back'),
      )
    },
  }
})

// What usePlayback returns, which a test can change between key presses.
// Every function on it is a spy, made once per name.
const playbackState = vi.hoisted(() => ({
  currentTitle: null as string | null,
  status: { playing: false, positionMs: 0, currentRecordingNodeId: null, currentFileId: null, currentDurationMs: null, volume: 1 },
  queueBusy: false,
  shuffled: false,
  problem: null,
  upNext: [],
  pause: vi.fn(),
  resume: vi.fn(async () => undefined),
  playLibrary: vi.fn(async () => undefined),
}))

vi.mock('./playback/usePlayback', () => {
  const target = playbackState as unknown as Record<string | symbol, unknown>
  const playback = new Proxy(target, {
    get: (t, key) => {
      if (!(key in t)) t[key] = vi.fn(async () => undefined)
      return t[key]
    },
  })
  return { usePlayback: () => playback }
})

import App from './App'
import { OPEN_CONNECT_EVENT } from './connect/openConnect'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SIGNED_IN = {
  ownerExists: true,
  setupCodeRequired: false,
  user: { role: 'owner', provider: 'password', displayName: 'Dan', email: null },
  oauth: { google: false, github: false },
}

// What the fake server answers for library-roots, and for the map's nodes.
let libraryRoots: { status: number; body: unknown } = { status: 200, body: [{ id: 1, path: '/music' }] }
let graphNodes: unknown[] = []

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
    harness.railMounts = 0
    playbackState.currentTitle = null
    playbackState.status = { ...playbackState.status, playing: false }
    playbackState.pause.mockClear()
    playbackState.resume.mockClear()
    playbackState.playLibrary.mockClear()
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
    graphNodes = []
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
        if (url.endsWith('/nodes')) return json(200, graphNodes)
        if (url.endsWith('/edges') || url.endsWith('/scan-jobs')) return json(200, [])
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

  const press = (init: KeyboardEventInit) =>
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
    })

  const searchOpen = () => container.querySelector('[data-testid="search"]') != null

  // The coordinator's review of #346: ⌘K opened search under the connect
  // screen and took the focus from it.
  it('answers no shortcut while the connect screen is open', async () => {
    await mount()
    await act(async () => {
      window.dispatchEvent(new CustomEvent(OPEN_CONNECT_EVENT, { detail: 'switch' }))
    })
    await press({ key: 'k', metaKey: true })
    await press({ key: 'k', ctrlKey: true })
    await press({ key: '/' })
    expect(searchOpen()).toBe(false)

    // Back to the app, and they work again.
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="close-connect"]')?.click()
    })
    await press({ key: 'k', metaKey: true })
    expect(searchOpen()).toBe(true)
  })

  it('opens nothing from the keyboard under the unreachable state', async () => {
    await mount()
    await setStatus({ ready: false, outage: asleep() })
    await press({ key: 'k', metaKey: true })
    await press({ key: 'k', ctrlKey: true })
    await press({ key: '/' })
    expect(searchOpen()).toBe(false)

    await setStatus({ ready: true, outage: null })
    await press({ key: '/' })
    expect(searchOpen()).toBe(true)
  })

  // The coordinator's second review of #346: the state sits under the
  // player so buffered audio can still be paused, and 12e2345 had taken
  // Space away with everything else.
  it('pauses and resumes with Space under the unreachable state, and starts nothing when nothing plays', async () => {
    graphNodes = [{ id: 1, type: 'recording', title: 'Track 1', subtitle: null, cover_hash: null }]
    await mount()
    await setStatus({ ready: false, outage: asleep() })

    playbackState.currentTitle = 'Track 1'
    playbackState.status = { ...playbackState.status, playing: true }
    await press({ key: ' ', code: 'Space' })
    expect(playbackState.pause).toHaveBeenCalledTimes(1)

    playbackState.status = { ...playbackState.status, playing: false }
    await press({ key: ' ', code: 'Space' })
    expect(playbackState.resume).toHaveBeenCalledTimes(1)

    playbackState.currentTitle = null
    await press({ key: ' ', code: 'Space' })
    expect(playbackState.playLibrary).not.toHaveBeenCalled()

    // With the server back, the same key shuffles the library.
    await setStatus({ ready: true, outage: null })
    await press({ key: ' ', code: 'Space' })
    expect(playbackState.playLibrary).toHaveBeenCalledTimes(1)
  })

  // The coordinator's review of #346: the connect screen moved in the tree
  // when the server first answered, which lost what was typed.
  it('keeps the connect screen, and what was typed in it, when the server answers for the first time', async () => {
    harness.status = { ...harness.status, ready: false, everConnected: false, server: null }
    await mount()
    expect(container.textContent).toContain('connecting…')
    await act(async () => {
      window.dispatchEvent(new CustomEvent(OPEN_CONNECT_EVENT, { detail: 'unreachable' }))
    })
    const input = container.querySelector<HTMLInputElement>('[aria-label="Server address"]')!
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setValue.call(input, '192.168.1.20')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(input.value).toBe('192.168.1.20')

    await setStatus({
      ready: true,
      everConnected: true,
      server: { version: '0.4.0', gitSha: 'abc1234', schemaVersion: MIN_SERVER_SCHEMA_VERSION, outOfDate: false, update: null },
    })

    expect(harness.connectMounts).toBe(1)
    expect(container.querySelector<HTMLInputElement>('[aria-label="Server address"]')).toBe(input)
    expect(input.value).toBe('192.168.1.20')
  })

  // The coordinator's second review of #346: App switched between the bare
  // app and the app inside the owner gate on outOfDate, so updating an
  // out-of-date server, and the restart that takes, remounted the app and
  // lost the queue, the current track and the web player.
  it('keeps the app mounted when an out-of-date server is updated underneath it', async () => {
    const outOfDate = { version: '0.3.0', gitSha: 'abc1234', schemaVersion: MIN_SERVER_SCHEMA_VERSION - 1, outOfDate: true, update: null }
    harness.status = { ...harness.status, server: outOfDate }
    await mount()
    expect(harness.railMounts).toBe(1)

    // The update's restart: an outage, then the new server.
    await setStatus({ ready: false, outage: asleep() })
    await setStatus({
      ready: true,
      outage: null,
      server: { version: '0.4.0', gitSha: 'def5678', schemaVersion: MIN_SERVER_SCHEMA_VERSION, outOfDate: false, update: null },
    })
    expect(harness.railMounts).toBe(1)

    // And back, should a check read it as out of date again.
    await setStatus({ server: outOfDate })
    expect(harness.railMounts).toBe(1)
  })
})
