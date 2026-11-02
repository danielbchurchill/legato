// @vitest-environment jsdom
import { act, createElement, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TracksTable } from './TracksTable'
import type { TrackRow } from './types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* The library's tracks table against a fake GET /library/tracks. jsdom lays
 * nothing out, so every element gets a desktop table's size, wide enough for
 * all eight columns, and --library-track-row is answered here. */

const TRACKS: TrackRow[] = [
  {
    id: 200,
    title: 'Like a Rolling Stone',
    artistId: 1,
    artistName: 'Bob Dylan',
    albumId: 100,
    albumTitle: 'Highway 61 Revisited',
    durationMs: 373_000,
    format: 'flac',
    dateAdded: '2026-10-01 00:00:00',
  },
  {
    id: 201,
    title: 'Untagged',
    artistId: null,
    artistName: null,
    albumId: null,
    albumTitle: null,
    durationMs: 60_000,
    format: 'mp3',
    dateAdded: '2026-10-01 00:00:00',
  },
]

let root: Root | null = null

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const route = new URL(input).pathname.replace(/^.*\/api\/v1/, '')
      if (route === '/library/tracks') return Response.json({ items: TRACKS, total: TRACKS.length })
      return Response.json({})
    }),
  )
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(800)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 1000,
    bottom: 800,
    width: 1000,
    height: 800,
    toJSON: () => ({}),
  })
  const computed = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element: Element) => {
    const style = computed(element)
    return new Proxy(style, {
      get(target, key) {
        if (key === 'getPropertyValue') return (name: string) => (name === '--library-track-row' ? '48px' : target.getPropertyValue(name))
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  })
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function render() {
  const onOpen = vi.fn()
  const onPlay = vi.fn()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const scrollRef = createRef<HTMLDivElement>()
  root = createRoot(container)
  await act(async () => {
    root!.render(
      createElement(
        'div',
        { ref: scrollRef },
        createElement(TracksTable, {
          scrollRef,
          sort: 'title',
          dir: 'asc',
          onSort: () => undefined,
          playingId: null,
          playing: false,
          onOpen,
          onPlay,
        }),
      ),
    )
  })
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
  return { container, onOpen, onPlay }
}

const row = (container: HTMLElement, title: string) =>
  [...container.querySelectorAll<HTMLElement>('[role="row"]')].find((r) => r.textContent?.includes(title))!
const cellButton = (row: HTMLElement, name: string) =>
  [...row.querySelectorAll<HTMLButtonElement>('[role="cell"] button')].find((b) => b.textContent === name)

// #451: from a track to its artist and its album.
describe('the tracks table', () => {
  it("opens the track's artist from its artist cell, and nothing else", async () => {
    const { container, onOpen } = await render()
    act(() => cellButton(row(container, 'Like a Rolling Stone'), 'Bob Dylan')!.click())
    expect(onOpen.mock.calls).toEqual([[1]])
  })

  it("opens the track's album from its album cell, and nothing else", async () => {
    const { container, onOpen } = await render()
    act(() => cellButton(row(container, 'Like a Rolling Stone'), 'Highway 61 Revisited')!.click())
    expect(onOpen.mock.calls).toEqual([[100]])
  })

  it('still opens the track from anywhere else in the row', async () => {
    const { container, onOpen } = await render()
    const track = row(container, 'Like a Rolling Stone')
    act(() => track.querySelector<HTMLElement>('[title="Like a Rolling Stone"]')!.click())
    // The artist cell around the link, past the end of the name.
    act(() => cellButton(track, 'Bob Dylan')!.parentElement!.click())
    act(() => track.click())
    expect(onOpen.mock.calls).toEqual([[200], [200], [200]])
  })

  it('still plays the track from its number', async () => {
    const { container, onOpen, onPlay } = await render()
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Play Like a Rolling Stone"]')!.click())
    expect(onPlay).toHaveBeenCalledOnce()
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('leaves a track with no artist or album tag as text', async () => {
    const { container } = await render()
    const untagged = row(container, 'Untagged')
    expect([...untagged.querySelectorAll('[role="cell"] button')].map((b) => b.getAttribute('aria-label'))).toEqual(['Play Untagged'])
  })
})
