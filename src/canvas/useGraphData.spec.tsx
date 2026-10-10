// @vitest-environment jsdom
//
// Issue #119, the coordinator's second review of #346: a graph refetch that
// fails, set off by a scan or enrichment event, while the server is
// restarting. It went unhandled, and it left `loading` true, which stops
// Canvas syncing any later graph.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useGraphData } from './useGraphData'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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
  static send(event: string) {
    for (const socket of FakeSocket.made) socket.onmessage?.({ data: JSON.stringify({ event, payload: {} }) })
  }
}

const NODES = [{ id: 1, type: 'artist', title: 'One' }]

describe('useGraphData when a refetch fails', () => {
  let root: Root | null = null
  // How the fake server answers /nodes and /edges.
  let answer: 'ok' | 'error' | 'down' = 'ok'

  beforeEach(() => {
    vi.useFakeTimers()
    FakeSocket.made = []
    answer = 'ok'
    vi.stubGlobal('WebSocket', FakeSocket)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (answer === 'down') throw new TypeError('Failed to fetch')
        if (answer === 'error') return { ok: false, status: 500, json: async () => ({ error: 'database is locked' }) } as Response
        return { ok: true, status: 200, json: async () => NODES } as Response
      }),
    )
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  async function mount() {
    const seen: { current: ReturnType<typeof useGraphData> | null } = { current: null }
    function Harness() {
      seen.current = useGraphData()
      return null
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    await act(async () => {
      root = createRoot(container)
      root.render(createElement(Harness))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    return seen
  }

  it.each(['down', 'error'] as const)('keeps the graph it has and stops loading when the server is %s', async (how) => {
    const seen = await mount()
    expect(seen.current?.loading).toBe(false)
    expect(seen.current?.nodes).toEqual(NODES)

    answer = how
    await act(async () => FakeSocket.send('scan:done'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500)
    })

    expect(seen.current?.loading).toBe(false)
    expect(seen.current?.nodes).toEqual(NODES)
  })

  it("doesn't take a first load that failed for an empty library", async () => {
    answer = 'down'
    const seen = await mount()

    expect(seen.current?.loading).toBe(true)
    expect(seen.current?.nodes).toEqual([])
  })
})
