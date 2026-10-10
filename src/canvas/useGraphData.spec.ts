// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useGraphData } from './useGraphData'

/* When the map fetches its graph again (#302). It follows enrich:applied and
 * scan:done, coalesced, with a 10 s bound so a drain that never pauses
 * still shows its photos. A description changes nothing on the map. */

let sockets: { onmessage: ((msg: { data: string }) => void) | null }[]
let root: Root | null = null

function send(event: string, payload: unknown) {
  for (const socket of sockets) socket.onmessage?.({ data: JSON.stringify({ event, payload }) })
}

const graphFetches = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/nodes')).length

beforeEach(() => {
  sockets = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json([])),
  )
  vi.stubGlobal(
    'WebSocket',
    class {
      onmessage: ((msg: { data: string }) => void) | null = null
      constructor() {
        sockets.push(this)
      }
      close() {}
    },
  )
  vi.useFakeTimers()
  function Harness() {
    useGraphData()
    return null
  }
  act(() => {
    root = createRoot(document.createElement('div'))
    root.render(createElement(Harness))
  })
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function everySecond(times: number, event: string, payload: unknown) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      send(event, payload)
      await vi.advanceTimersByTimeAsync(1_000)
    })
  }
}

describe('useGraphData refetch (#302)', () => {
  it('fetches every 10 s while artist photos keep arriving, and once when they stop', async () => {
    expect(graphFetches()).toBe(1)
    await everySecond(25, 'enrich:applied', { nodeId: 1, kind: 'artist_image' })
    expect(graphFetches()).toBe(3)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500)
    })
    expect(graphFetches()).toBe(4)
  })

  it("doesn't fetch for a description, which the map doesn't show", async () => {
    await everySecond(25, 'enrich:applied', { nodeId: 1, kind: 'description' })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500)
    })
    expect(graphFetches()).toBe(1)
  })
})
