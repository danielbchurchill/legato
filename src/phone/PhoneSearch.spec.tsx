// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GraphDataContext, type GraphData } from '../canvas/graphContext'
import type { GraphEdge, GraphNode } from '../canvas/useGraphData'
import type { usePlayback } from '../playback/usePlayback'
import { SearchField, SearchResultsList } from './PhoneSearch'
import { usePhoneSearch, type PhoneSearchState } from './searchState'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Playback = ReturnType<typeof usePlayback>

const node = (id: number, type: string, title: string, subtitle: string | null = null, duration: number | null = null): GraphNode => ({
  id,
  type,
  title,
  subtitle,
  canonical_duration_ms: duration,
  mbid: null,
  seed_x: null,
  seed_y: null,
  user_x: null,
  user_y: null,
  settled_x: null,
  settled_y: null,
  cover_hash: null,
})
const edge = (id: number, from: number, to: number, type: string): GraphEdge => ({
  id,
  from_node: from,
  to_node: to,
  type,
  source: 'tags',
  label: null,
  note: null,
})

// Dylan Moss, their record Dylan Moss Live with two tracks, and Dylan Hart,
// who produced both.
const nodes = [
  node(1, 'artist', 'Dylan Moss'),
  node(2, 'release', 'Dylan Moss Live', 'Dylan Moss'),
  node(3, 'recording', "Dylan's Dream", 'Dylan Moss', 27_000),
  node(4, 'recording', 'Highway Blues', 'Dylan Moss', 48_000),
  node(5, 'credit', 'Dylan Hart'),
]
const edges = [
  edge(1, 3, 1, 'performed_by'),
  edge(2, 4, 1, 'performed_by'),
  edge(3, 3, 2, 'appears_on'),
  edge(4, 4, 2, 'appears_on'),
  edge(5, 3, 5, 'produced_by'),
  edge(6, 4, 5, 'produced_by'),
]
const graph: GraphData = { nodes, edges, loading: false, refetch: async () => undefined, byId: new Map(nodes.map((n) => [n.id, n])) }

// The server's answers, in its rank order.
const HITS = [
  { id: 1, type: 'artist', title: 'Dylan Moss' },
  { id: 5, type: 'credit', title: 'Dylan Hart' },
  { id: 3, type: 'recording', title: "Dylan's Dream" },
  { id: 2, type: 'release', title: 'Dylan Moss Live' },
]

let hits = HITS
const asked: string[] = []

const roots: Root[] = []

beforeEach(() => {
  hits = HITS
  asked.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      asked.push(url)
      const path = new URL(url, 'http://test').pathname
      const body = path.endsWith('/search')
        ? hits
        : path.endsWith('/playlists')
          ? [{ id: 7, name: 'Dylan mix', track_count: 3 }]
          : path.endsWith('/summary')
            ? { releaseDate: '1966-05-16' }
            : null
      return { ok: true, json: async () => body }
    }),
  )
})

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()))
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

function render(node: ReactNode) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(createElement(GraphDataContext.Provider, { value: graph }, node)))
  return container
}

/* Past the search's debounce, and the answers it asked for. */
async function answered() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200))
  })
}

function fakePlayback(): Playback {
  return {
    queueBusy: false,
    playNode: vi.fn(async () => undefined),
    playAlbum: vi.fn(async () => undefined),
    playPlaylist: vi.fn(async () => undefined),
    playTracks: vi.fn(async () => undefined),
  } as unknown as Playback
}

type Handlers = {
  onCancel?: () => void
  onSubmit?: (search: PhoneSearchState) => void
  onOpenNode?: (id: number) => void
  onOpenPlaylist?: (id: number) => void
  onPlayed?: () => void
}

function Search({ query, playback, handlers = {} }: { query?: string; playback: Playback; handlers?: Handlers }) {
  const search = usePhoneSearch(true)
  if (query != null && search.query === '' && query !== '') search.setQuery(query)
  return (
    <>
      <SearchField search={search} onCancel={handlers.onCancel ?? (() => undefined)} onSubmit={() => handlers.onSubmit?.(search)} />
      <SearchResultsList
        search={search}
        playback={playback}
        onOpenNode={handlers.onOpenNode ?? (() => undefined)}
        onOpenPlaylist={handlers.onOpenPlaylist ?? (() => undefined)}
        onPlayed={handlers.onPlayed ?? (() => undefined)}
      />
    </>
  )
}

const input = (container: HTMLElement) => container.querySelector<HTMLInputElement>('input')!
const button = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.includes(text) || b.getAttribute('aria-label') === text,
  )!

function type(container: HTMLElement, value: string) {
  const el = input(container)
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function press(container: HTMLElement, key: string) {
  act(() => {
    input(container).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
}

describe('the phone search field', () => {
  it('takes the focus as it opens, with a 16px field iOS needs no zoom for', () => {
    const container = render(<Search playback={fakePlayback()} />)
    expect(document.activeElement).toBe(input(container))
    expect(input(container).className).toContain('text-[16px]')
  })

  it('opens the top result on Enter, and cancels on Escape or Cancel', async () => {
    const submitted: (string | undefined)[] = []
    const onCancel = vi.fn()
    const container = render(
      <Search playback={fakePlayback()} handlers={{ onCancel, onSubmit: (search) => submitted.push(search.top?.title) }} />,
    )
    type(container, 'dyl')
    await answered()
    press(container, 'Enter')
    expect(submitted).toEqual(['Dylan Moss'])
    press(container, 'Escape')
    act(() => button(container, 'Cancel').click())
    expect(onCancel).toHaveBeenCalledTimes(2)
  })

  it('clears the query from its clear button, shown only with something to clear', () => {
    const container = render(<Search playback={fakePlayback()} />)
    expect(button(container, 'Clear search')).toBeUndefined()
    type(container, 'dyl')
    act(() => button(container, 'Clear search').click())
    expect(input(container).value).toBe('')
    expect(document.activeElement).toBe(input(container))
  })
})

describe('the phone search results', () => {
  it("asks the palette's search, and groups what it finds as the handoff does", async () => {
    const container = render(<Search query="dyl" playback={fakePlayback()} />)
    await answered()
    expect(asked.some((url) => url.includes('/search?q=dyl&limit=100'))).toBe(true)
    const labels = [...container.querySelectorAll('h3')].map((h) => h.textContent)
    expect(labels).toEqual(['top result', 'albums', 'people', 'tracks', 'playlists'])
  })

  it('says what each result is, from the graph', async () => {
    const container = render(<Search query="dyl" playback={fakePlayback()} />)
    await answered()
    const text = container.textContent!
    expect(text).toContain('artist · 1 album · 2 tracks')
    expect(text).toContain('Dylan Moss · 1966')
    expect(text).toContain('producer · worked with Dylan Moss')
    expect(text).toContain('2 tracks')
    expect(text).toContain('0:27')
    expect(text).toContain('playlist · 3 tracks')
  })

  it('opens a node or a playlist, and plays the top result', async () => {
    const opened: number[] = []
    const playlists: number[] = []
    const onPlayed = vi.fn()
    const playback = fakePlayback()
    const container = render(
      <Search
        query="dyl"
        playback={playback}
        handlers={{ onOpenNode: (id) => opened.push(id), onOpenPlaylist: (id) => playlists.push(id), onPlayed }}
      />,
    )
    await answered()
    act(() => button(container, 'Dylan Moss Live').click())
    act(() => button(container, 'Dylan Hart').click())
    act(() => button(container, 'Dylan mix').click())
    expect(opened).toEqual([2, 5])
    expect(playlists).toEqual([7])
    // The artist's tracks, as the palette plays them.
    act(() => button(container, 'Play Dylan Moss').click())
    expect(playback.playTracks).toHaveBeenCalledWith([3, 4], 0, '')
    expect(onPlayed).toHaveBeenCalled()
  })

  it('offers no play for a producer at the top', async () => {
    hits = [{ id: 5, type: 'credit', title: 'Dylan Hart' }]
    const container = render(<Search query="hart" playback={fakePlayback()} />)
    await answered()
    expect(button(container, 'Play Dylan Hart')).toBeUndefined()
  })

  it('says when nothing matches, and asks nothing with nothing typed', async () => {
    const empty = render(<Search playback={fakePlayback()} />)
    await answered()
    expect(empty.textContent).toContain('Artists, albums, tracks and people')
    expect(asked.some((url) => url.includes('/search'))).toBe(false)

    hits = []
    const none = render(<Search query="zzz" playback={fakePlayback()} />)
    await answered()
    expect(none.textContent).toContain('No matches for “zzz”')
  })
})
