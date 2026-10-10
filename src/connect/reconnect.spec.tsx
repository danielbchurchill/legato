// @vitest-environment jsdom
//
// Issue #119, and the coordinator's review of #346: after an outage,
// everything that reads from the server reads once more. A scan that
// finished while the server was out of reach, or a restart onto a changed
// library, sent its events to a socket that wasn't there, so the hooks key
// their loads on the reconnect epoch rather than on those events alone.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useGraphData } from '../canvas/useGraphData'
import { useScanStatus } from '../hooks/useScanStatus'
import { useSettings } from '../hooks/useSettings'
import { useFavourites, usePlaylists } from '../panels/collectionsData'
import { useStats } from '../panels/healthData'
import { useNodeDetail } from '../panels/useNodeDetail'
import {
  announceServerBack,
  inOutage,
  noteLatestScan,
  noteOutage,
  noteReadFailed,
  provideSessionCheck,
  reconnectEpoch,
  SERVER_BACK_EVENT,
  serverBackEpoch,
  BACK_CHECK_TIMEOUT_MS,
  useReconnectEpoch,
} from './reconnect'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The library before the outage, and after a scan that ran during it.
const before = { nodes: [{ id: 1, type: 'artist', title: 'One' }], settings: { viewMode: 'map' } }
const after = {
  nodes: [
    { id: 1, type: 'artist', title: 'One' },
    { id: 2, type: 'artist', title: 'Two' },
  ],
  settings: { viewMode: 'library' },
}

describe('the reconnect epoch', () => {
  let root: Root | null = null
  let library = before

  beforeEach(() => {
    library = before
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
        const path = new URL(url).pathname.replace('/api/v1', '')
        const body =
          path === '/nodes'
            ? library.nodes
            : path === '/settings'
              ? library.settings
              : path === '/nodes/1'
                ? { id: 1, title: library === before ? 'One' : 'One (remastered)' }
                : path === '/stats'
                  ? { artists: library.nodes.length }
                  : []
        return { ok: true, status: 200, json: async () => body } as Response
      }),
    )
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    vi.unstubAllGlobals()
  })

  const settle = () =>
    act(async () => {
      for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0))
    })

  const calls = (path: string) => vi.mocked(fetch).mock.calls.filter(([url]) => new URL(String(url)).pathname === `/api/v1${path}`).length

  function mountAll() {
    const seen: {
      graph: ReturnType<typeof useGraphData> | null
      settings: ReturnType<typeof useSettings> | null
      node: ReturnType<typeof useNodeDetail> | null
      stats: ReturnType<typeof useStats>
    } = { graph: null, settings: null, node: null, stats: null }
    function Harness() {
      seen.graph = useGraphData()
      seen.settings = useSettings()
      seen.node = useNodeDetail(1)
      seen.stats = useStats()
      usePlaylists()
      useFavourites()
      useScanStatus()
      return null
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    act(() => {
      root = createRoot(container)
      root.render(createElement(Harness))
    })
    return seen
  }

  const ENDPOINTS = ['/nodes', '/edges', '/settings', '/nodes/1', '/stats', '/playlists', '/favourites', '/scan-jobs']

  it('has the map, settings, collections, health and scan state read once more after an outage', async () => {
    const seen = mountAll()
    await settle()
    for (const path of ENDPOINTS) expect(calls(path), path).toBe(1)
    expect(seen.graph?.nodes.map((n) => n.title)).toEqual(['One'])
    expect(seen.settings?.settings.viewMode).toBe('map')

    library = after
    await act(async () => {
      await announceServerBack({ restarted: true })
    })
    await settle()

    for (const path of ENDPOINTS) expect(calls(path), path).toBe(2)
    expect(seen.graph?.nodes.map((n) => n.title)).toEqual(['One', 'Two'])
    expect(seen.settings?.settings.viewMode).toBe('library')
    expect(seen.node?.node?.title).toBe('One (remastered)')
    expect(seen.stats?.artists).toBe(2)
  })

  it("keeps a setting changed here while the reload was out over the one it brings back", async () => {
    const seen = mountAll()
    await settle()

    let answer: (res: Response) => void = () => undefined
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname
      if (path === '/api/v1/settings' && !init?.method) return new Promise<Response>((resolve) => (answer = resolve))
      if (path === '/api/v1/settings') return { ok: true, status: 200, json: async () => ({ viewMode: 'library' }) } as Response
      return { ok: true, status: 200, json: async () => [] } as Response
    })
    await act(async () => {
      await announceServerBack({ restarted: true })
    })
    await act(async () => {
      await seen.settings?.updateSettings({ viewMode: 'library' })
    })
    await act(async () => {
      answer({ ok: true, status: 200, json: async () => ({ viewMode: 'map' }) } as Response)
    })
    await settle()

    expect(seen.settings?.settings.viewMode).toBe('library')
  })

  it('goes up by one per outage, after the session check, and only then', async () => {
    let finish: () => void = () => undefined
    const withdraw = provideSessionCheck(() => new Promise<void>((resolve) => (finish = resolve)))
    const epochs: number[] = []
    function Harness() {
      epochs.push(useReconnectEpoch())
      return null
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    act(() => {
      root = createRoot(container)
      root.render(createElement(Harness))
    })
    const start = reconnectEpoch()

    let announced: Promise<void> = Promise.resolve()
    act(() => {
      announced = announceServerBack({ restarted: true })
    })
    await settle()
    expect(epochs.at(-1)).toBe(start)

    await act(async () => {
      finish()
      await announced
    })
    expect(epochs.at(-1)).toBe(start + 1)
    withdraw()
  })
})

// The coordinator's second review of #346, finding 9: the full resync costs
// the graph, every panel and their covers, so it runs only when the
// server's data could have moved on.
describe('what an outage reads again', () => {
  // The server's latest scan job, as /scan-jobs gives it.
  let latest = { id: 7, status: 'done' }

  beforeEach(() => {
    latest = { id: 7, status: 'done' }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => [latest] }) as Response),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function outage(restarted: boolean) {
    noteOutage()
    await announceServerBack({ restarted })
  }

  it('reads everything again after a restart', async () => {
    noteLatestScan(latest)
    const epoch = reconnectEpoch()
    await outage(true)
    expect(reconnectEpoch()).toBe(epoch + 1)
  })

  it("only replaces the sockets and retries media after an outage on this device's side", async () => {
    noteLatestScan(latest)
    const epoch = reconnectEpoch()
    const backs = serverBackEpoch()
    const back = vi.fn()
    window.addEventListener(SERVER_BACK_EVENT, back)
    await outage(false)

    expect(back).toHaveBeenCalledTimes(1)
    expect(serverBackEpoch()).toBe(backs + 1)
    expect(reconnectEpoch()).toBe(epoch)
    expect(inOutage()).toBe(false)
    window.removeEventListener(SERVER_BACK_EVENT, back)
  })

  it('reads everything again when a scan started or finished while the server was out of reach', async () => {
    noteLatestScan({ id: 7, status: 'running' })
    const epoch = reconnectEpoch()
    await outage(false)
    expect(reconnectEpoch()).toBe(epoch + 1)

    latest = { id: 8, status: 'done' }
    await outage(false)
    expect(reconnectEpoch()).toBe(epoch + 2)

    // Nothing new the next time.
    await outage(false)
    expect(reconnectEpoch()).toBe(epoch + 2)
  })

  it('reads everything again when a read failed meanwhile, so nothing is left without its data', async () => {
    noteLatestScan(latest)
    const epoch = reconnectEpoch()
    noteReadFailed()
    await outage(false)
    expect(reconnectEpoch()).toBe(epoch + 1)

    await outage(false)
    expect(reconnectEpoch()).toBe(epoch + 1)
  })

  it("reads everything again when it can't tell which scan is the latest", async () => {
    noteLatestScan(latest)
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const epoch = reconnectEpoch()
    await outage(false)
    expect(reconnectEpoch()).toBe(epoch + 1)
  })
})

// Finding 5: a second outage declared while the first one's end waited on
// the session check.
describe('a second outage during the session check', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("doesn't announce the server back, and leaves the second outage standing", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => [] }) as Response))
    let finish: () => void = () => undefined
    const withdraw = provideSessionCheck(() => new Promise<void>((resolve) => (finish = resolve)))
    const back = vi.fn()
    window.addEventListener(SERVER_BACK_EVENT, back)
    const epoch = reconnectEpoch()

    noteOutage()
    const first = announceServerBack({ restarted: true })
    noteOutage() // gone again before the session check came back
    finish()
    await first

    expect(back).not.toHaveBeenCalled()
    expect(reconnectEpoch()).toBe(epoch)
    expect(inOutage()).toBe(true)

    // The second one's end announces it.
    const second = announceServerBack({ restarted: true })
    finish()
    await second
    expect(back).toHaveBeenCalledTimes(1)
    expect(reconnectEpoch()).toBe(epoch + 1)
    expect(inOutage()).toBe(false)
    window.removeEventListener(SERVER_BACK_EVENT, back)
    withdraw()
  })

  it('stops waiting for a session check that never answers', async () => {
    vi.useFakeTimers()
    const withdraw = provideSessionCheck(() => new Promise<void>(() => undefined))
    const back = vi.fn()
    window.addEventListener(SERVER_BACK_EVENT, back)

    noteOutage()
    const announced = announceServerBack({ restarted: true })
    await vi.advanceTimersByTimeAsync(BACK_CHECK_TIMEOUT_MS - 1)
    expect(back).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await announced

    expect(back).toHaveBeenCalledTimes(1)
    window.removeEventListener(SERVER_BACK_EVENT, back)
    withdraw()
  })
})
