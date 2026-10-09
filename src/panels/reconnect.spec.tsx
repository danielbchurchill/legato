// @vitest-environment jsdom
//
// Issue #119, the coordinator's second review of #346: panels the resync
// missed, which kept what a failed load left them (nothing, or an empty
// list) after the server came back. useLyrics also asked again in a tight
// loop whenever its answer was null, which a track with no lyrics and a
// server that's down both give.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { announceServerBack } from '../connect/reconnect'
import { AddToPlaylistButton } from './AddToPlaylistButton'
import { useLyrics } from './useLyrics'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const LYRICS = { plainLyrics: 'la la la', syncedLyrics: null, instrumental: false, found: true }

describe('panels after the server comes back', () => {
  let root: Root | null = null
  let container: HTMLDivElement
  // How the fake server answers: up, down, or up with no lyrics for anything.
  let server: 'up' | 'down' | 'no-lyrics' = 'up'

  beforeEach(() => {
    server = 'up'
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
      'fetch',
      vi.fn(async (url: string) => {
        if (server === 'down') throw new TypeError('Failed to fetch')
        const path = new URL(url).pathname.replace('/api/v1', '')
        if (path.endsWith('/lyrics')) {
          return server === 'no-lyrics'
            ? ({ ok: false, status: 404, json: async () => ({ error: 'not found' }) } as Response)
            : ({ ok: true, status: 200, json: async () => LYRICS } as Response)
        }
        if (path === '/playlists') return { ok: true, status: 200, json: async () => [{ id: 1, name: 'Road trip', track_count: 3 }] } as Response
        return { ok: true, status: 200, json: async () => ({}) } as Response
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
      for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0))
    })

  const calls = (suffix: string) => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith(suffix)).length

  async function render(element: ReturnType<typeof createElement>) {
    await act(async () => {
      root = createRoot(container)
      root.render(element)
    })
    await settle()
  }

  function mountLyrics(nodeId = 1) {
    const seen: { current: ReturnType<typeof useLyrics> | null } = { current: null }
    function Harness() {
      seen.current = useLyrics(nodeId, true)
      return null
    }
    return { seen, element: createElement(Harness) }
  }

  it('asks for a track with no lyrics once, not in a loop', async () => {
    server = 'no-lyrics'
    const { seen, element } = mountLyrics()
    await render(element)

    expect(seen.current?.lyrics).toBeNull()
    expect(calls('/nodes/1/lyrics')).toBe(1)
  })

  it('asks once while the server is down, and again once it is back', async () => {
    server = 'down'
    const { seen, element } = mountLyrics()
    await render(element)
    expect(seen.current?.lyrics).toBeNull()
    expect(calls('/nodes/1/lyrics')).toBe(1)

    server = 'up'
    await act(async () => announceServerBack({ restarted: true }))
    await settle()

    expect(seen.current?.lyrics).toEqual(LYRICS)
    expect(calls('/nodes/1/lyrics')).toBe(2)
  })

  it("keeps the lyrics shown while they load again, and doesn't show another track's", async () => {
    const { seen, element } = mountLyrics()
    await render(element)
    expect(seen.current?.lyrics).toEqual(LYRICS)

    let answer: (res: Response) => void = () => undefined
    vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>((resolve) => (answer = resolve)))
    await act(async () => announceServerBack({ restarted: true }))
    expect(seen.current?.lyrics).toEqual(LYRICS)
    await act(async () => answer({ ok: true, status: 200, json: async () => LYRICS } as Response))
    await settle()
    expect(seen.current?.lyrics).toEqual(LYRICS)

    // Another track: loading, not the last one's.
    function Other() {
      seen.current = useLyrics(2, true)
      return null
    }
    vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>(() => undefined))
    await act(async () => root?.render(createElement(Other)))
    expect(seen.current?.lyrics).toBe('loading')
  })

  it('loads an open add-to-playlist list again once the server is back', async () => {
    server = 'down'
    await render(createElement(AddToPlaylistButton, { nodeId: 1 }))
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Add to playlist"]')?.click())
    await settle()
    expect(container.textContent).not.toContain('Road trip')

    server = 'up'
    await act(async () => announceServerBack({ restarted: true }))
    await settle()

    expect(container.textContent).toContain('Road trip')
  })
})
