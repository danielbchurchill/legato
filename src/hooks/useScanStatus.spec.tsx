// @vitest-environment jsdom
//
// Issue #119, the coordinator's second review of #346: the scan state the
// map's first-scan card shows, after the server comes back. A restart
// pauses the run it interrupted, and a run that ended meanwhile said so to
// a socket that wasn't there, so the last progress could stay up for good.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { announceServerBack } from '../connect/reconnect'
import { useScanStatus } from './useScanStatus'

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
  static send(event: string, payload: unknown) {
    for (const socket of FakeSocket.made) socket.onmessage?.({ data: JSON.stringify({ event, payload }) })
  }
}

describe('useScanStatus after the server comes back', () => {
  let root: Root | null = null
  let jobs: { id: number; status: string; error_message: string | null }[] = []

  beforeEach(() => {
    FakeSocket.made = []
    jobs = [{ id: 5, status: 'running', error_message: null }]
    vi.stubGlobal('WebSocket', FakeSocket)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => jobs }) as Response),
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

  async function mount() {
    const seen: { current: ReturnType<typeof useScanStatus> | null } = { current: null }
    function Harness() {
      seen.current = useScanStatus()
      return null
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    await act(async () => {
      root = createRoot(container)
      root.render(createElement(Harness))
    })
    await settle()
    await act(async () => FakeSocket.send('scan:progress', { jobId: 5, libraryRootId: 1, stage: 'read_tags', filesScanned: 120, filesTotal: 700 }))
    expect(seen.current?.scanning).toBe(true)
    expect(seen.current?.progress?.filesScanned).toBe(120)
    return seen
  }

  it('drops the progress of a run the restart paused', async () => {
    const seen = await mount()
    jobs = [{ id: 5, status: 'paused', error_message: null }]
    await act(async () => announceServerBack({ restarted: true }))
    await settle()

    expect(seen.current?.scanning).toBe(false)
    expect(seen.current?.progress).toBeNull()
  })

  it('keeps the progress of a run still going, for its next event to move on', async () => {
    const seen = await mount()
    await act(async () => announceServerBack({ restarted: true }))
    await settle()

    expect(seen.current?.scanning).toBe(true)
    expect(seen.current?.progress?.filesScanned).toBe(120)
  })
})
