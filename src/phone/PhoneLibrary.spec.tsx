// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GraphDataContext, type GraphData } from '../canvas/graphContext'
import type { GraphNode } from '../canvas/useGraphData'
import type { usePlayback } from '../playback/usePlayback'
import type { AlbumRow, ArtistRow, CreditRow, TrackRow } from '../library/types'
import { PhoneLibrary } from './PhoneLibrary'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* The phone's library tab (#389, step 3) against a fake server. jsdom lays
 * nothing out, so every element is given a phone's size and the library's
 * --library-* tokens are answered here, which is enough for the grid and
 * the rows to place what's on screen. */

const ALBUMS: AlbumRow[] = Array.from({ length: 5 }, (_, i) => ({
  id: 100 + i,
  title: `Album ${i}`,
  artistId: 1,
  artistName: 'Bob Dylan',
  year: 1965,
  trackCount: 2,
  totalDurationMs: 0,
  dateAdded: '2026-10-01 00:00:00',
  coverHash: null,
}))
const ARTISTS: ArtistRow[] = [{ id: 1, name: 'Bob Dylan', releases: 5 }]
const TRACKS: TrackRow[] = [
  {
    id: 200,
    title: 'Like a Rolling Stone',
    artistId: 1,
    artistName: 'Bob Dylan',
    albumId: 100,
    albumTitle: 'Album 0',
    durationMs: 373_000,
    format: 'flac',
    dateAdded: '2026-10-01 00:00:00',
  },
]
const CREDITS: CreditRow[] = [{ id: 300, name: 'Tom Wilson', roles: ['producer', 'engineer'], tracks: 23 }]

const PAGES: Record<string, unknown[]> = {
  '/library/albums': ALBUMS,
  '/library/artists': ARTISTS,
  '/library/tracks': TRACKS,
  '/library/credits': CREDITS,
}

let requests: URL[]
let root: Root | null = null

const graph = (nodes: number): GraphData => {
  const list = Array.from({ length: nodes }, (_, i) => ({ id: i + 1, type: 'release', title: `n${i}` }) as GraphNode)
  return { nodes: list, edges: [], loading: false, refetch: async () => undefined, byId: new Map(list.map((n) => [n.id, n])) }
}

beforeEach(() => {
  requests = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = new URL(input)
      requests.push(url)
      const route = url.pathname.replace(/^.*\/api\/v1/, '')
      const page = PAGES[route]
      if (page) return Response.json({ items: page, total: page.length })
      if (route === '/scan-jobs') return Response.json([])
      return Response.json({})
    }),
  )
  vi.stubGlobal(
    'WebSocket',
    class {
      onmessage = null
      close() {}
    },
  )
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })),
  )
  // A phone-sized box for everything, and the library's tokens.
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(358)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 358,
    bottom: 600,
    width: 358,
    height: 600,
    toJSON: () => ({}),
  })
  const computed = window.getComputedStyle.bind(window)
  const TOKENS: Record<string, string> = { '--library-cell-min': '168px', '--library-row-gap': '16px', '--library-column-gap': '14px' }
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element: Element) => {
    const style = computed(element)
    return new Proxy(style, {
      get(target, key) {
        if (key === 'getPropertyValue') return (name: string) => TOKENS[name] ?? target.getPropertyValue(name)
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

async function settle() {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

async function render(props: Partial<Parameters<typeof PhoneLibrary>[0]> = {}, data = graph(10)) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const playback = { playNode: vi.fn(), status: { currentRecordingNodeId: null, playing: false } }
  const onOpenNode = vi.fn()
  const onShowMap = vi.fn()
  await act(async () => {
    root = createRoot(container)
    root.render(
      createElement(
        GraphDataContext.Provider,
        { value: data },
        createElement(PhoneLibrary, {
          onOpenNode,
          playback: playback as unknown as ReturnType<typeof usePlayback>,
          noLibrary: false,
          onShowMap,
          ...props,
        }),
      ),
    )
  })
  await settle()
  return { container, playback, onOpenNode, onShowMap }
}

const sortLine = (container: HTMLElement) => container.querySelector('button[aria-label^="Sort:"]')?.textContent
const chip = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Show"] button')].find((b) => b.textContent === name)!

async function choose(container: HTMLElement, name: string) {
  await act(async () => chip(container, name).click())
  await settle()
}

describe('the phone library tab', () => {
  it('opens on albums, newest first, as the frame does', async () => {
    const { container } = await render()
    expect(chip(container, 'albums').getAttribute('aria-pressed')).toBe('true')
    expect(sortLine(container)).toBe('5 albums · recently added')
    const albums = requests.find((url) => url.pathname.endsWith('/library/albums'))!
    expect(albums.searchParams.get('sort')).toBe('dateAdded')
    expect(albums.searchParams.get('dir')).toBe('desc')
  })

  it('draws albums two to a row, and opens one with the select the map uses', async () => {
    const { container, onOpenNode } = await render()
    const row = container.querySelector('[aria-label="Albums"] .grid') as HTMLElement
    expect(row.style.gridTemplateColumns).toBe('repeat(2, minmax(0, 1fr))')
    const album = container.querySelector<HTMLButtonElement>('button[aria-label="Album 0, Bob Dylan"]')!
    await act(async () => album.click())
    expect(onOpenNode).toHaveBeenCalledWith(100)
  })

  it('switches layout with the chips, each with its own count and order', async () => {
    const { container } = await render()
    await choose(container, 'artists')
    expect(chip(container, 'artists').getAttribute('aria-pressed')).toBe('true')
    expect(chip(container, 'albums').getAttribute('aria-pressed')).toBe('false')
    expect(sortLine(container)).toBe('1 artist · name A–Z')
    await choose(container, 'tracks')
    expect(sortLine(container)).toBe('1 track · title A–Z')
    await choose(container, 'credits')
    expect(sortLine(container)).toBe('1 person · name A–Z')
    expect(requests.some((url) => url.pathname.endsWith('/library/credits'))).toBe(true)
  })

  it('plays a track from its row, and says so', async () => {
    const { container, playback } = await render()
    await choose(container, 'tracks')
    const row = container.querySelector<HTMLButtonElement>('button[aria-label="Play Like a Rolling Stone, Bob Dylan"]')!
    expect(row.textContent).toContain('6:13')
    await act(async () => row.click())
    expect(playback.playNode).toHaveBeenCalledWith(200, 'Like a Rolling Stone')
  })

  it('lists a person with what they did and on how many tracks, and opens them', async () => {
    const { container, onOpenNode } = await render()
    await choose(container, 'credits')
    const person = [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Credits"] button')].find((b) =>
      b.textContent?.includes('Tom Wilson'),
    )!
    expect(person.textContent).toContain('producer · engineer')
    expect(person.textContent).toContain('23 tracks')
    await act(async () => person.click())
    expect(onOpenNode).toHaveBeenCalledWith(300)
  })

  it('has no layout to show without a music folder, and sends you to the map to add one', async () => {
    const { container, onShowMap } = await render({ noLibrary: true }, graph(0))
    expect(container.querySelector('[aria-label="Show"]')).toBeNull()
    expect(container.textContent).toContain('Nothing here yet')
    const add = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Add your music')!
    expect(add.className).toContain('touch-target')
    await act(async () => add.click())
    expect(onShowMap).toHaveBeenCalled()
  })

  for (const [job, words] of [
    [{ id: 1, status: 'running' }, 'Reading your library'],
    [{ id: 1, status: 'error', error_message: 'disk gone' }, 'The scan stopped'],
    [{ id: 1, status: 'done' }, 'No music found'],
  ] as const) {
    it(`says "${words}" for a folder with nothing matched, after a ${job.status} scan`, async () => {
      vi.mocked(fetch).mockImplementation(async (input) => {
        const route = new URL(String(input)).pathname.replace(/^.*\/api\/v1/, '')
        return Response.json(route === '/scan-jobs' ? [job] : {})
      })
      const { container } = await render({}, graph(0))
      expect(container.textContent).toContain(words)
      expect(container.querySelector('[aria-label="Show"]')).toBeNull()
    })
  }
})
