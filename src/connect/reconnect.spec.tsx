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
import { announceServerBack, provideSessionCheck, reconnectEpoch, useReconnectEpoch } from './reconnect'

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
      await announceServerBack(Date.now() - 60_000)
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
      await announceServerBack(0)
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
      announced = announceServerBack(0)
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
