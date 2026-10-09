// @vitest-environment jsdom
//
// Issue #119: the server's events reach the client again after an outage.
// The coordinator's review of #346 found a socket left half open (a host
// that slept, a network that changed) still reads OPEN, so it was never
// replaced and events stopped for good.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { announceServerBack } from '../connect/reconnect'
import { useWsEvent } from './useWs'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class FakeSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 3
  static made: FakeSocket[] = []
  readyState = FakeSocket.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((msg: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  close = vi.fn(() => {
    this.readyState = FakeSocket.CLOSED
    this.onclose?.()
  })

  constructor() {
    FakeSocket.made.push(this)
  }

  open() {
    this.readyState = FakeSocket.OPEN
    this.onopen?.()
  }

  send(event: string) {
    this.onmessage?.({ data: JSON.stringify({ event, payload: null }) })
  }
}

describe('useWsEvent', () => {
  let root: Root | null = null

  beforeEach(() => {
    vi.useFakeTimers()
    FakeSocket.made = []
    vi.stubGlobal('WebSocket', FakeSocket)
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  function mount(onEvent: () => void) {
    function Harness() {
      useWsEvent(['scan:done'], onEvent)
      return null
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    act(() => {
      root = createRoot(container)
      root.render(createElement(Harness))
    })
  }

  it('replaces a socket that still reads open once the server is back after an outage', async () => {
    const onEvent = vi.fn()
    mount(onEvent)
    const halfOpen = FakeSocket.made[0]
    halfOpen.open()

    await act(async () => {
      await announceServerBack(0)
    })

    expect(halfOpen.close).toHaveBeenCalled()
    expect(FakeSocket.made).toHaveLength(2)
    const fresh = FakeSocket.made[1]
    fresh.open()
    fresh.send('scan:done')
    expect(onEvent).toHaveBeenCalledTimes(1)

    // The old one closing doesn't start a retry of its own.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(FakeSocket.made).toHaveLength(2)
  })

  it('opens again at once, rather than waiting out its backoff, when the server is back', async () => {
    mount(() => undefined)
    for (let i = 0; i < 4; i++) {
      FakeSocket.made.at(-1)?.close()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2 ** i * 1000)
      })
    }
    const count = FakeSocket.made.length
    FakeSocket.made.at(-1)?.close() // the next try waits 16 s

    await act(async () => {
      await announceServerBack(0)
    })
    expect(FakeSocket.made).toHaveLength(count + 1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(16_000)
    })
    expect(FakeSocket.made).toHaveLength(count + 1)
  })
})
