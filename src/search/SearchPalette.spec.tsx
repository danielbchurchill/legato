// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GraphDataContext, type GraphData } from '../canvas/graphContext'
import type { GraphEdge, GraphNode } from '../canvas/useGraphData'
import type { usePlayback } from '../playback/usePlayback'
import { SearchPalette } from './SearchPalette'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Playback = ReturnType<typeof usePlayback>

const node = (id: number, type: string, title: string): GraphNode => ({
  id,
  type,
  title,
  subtitle: null,
  canonical_duration_ms: null,
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

// Dylan Moss and their record Dylan Moss Live, with two tracks.
const nodes = [
  node(1, 'artist', 'Dylan Moss'),
  node(2, 'release', 'Dylan Moss Live'),
  node(3, 'recording', "Dylan's Dream"),
  node(4, 'recording', 'Highway Blues'),
]
const edges = [edge(1, 3, 1, 'performed_by'), edge(2, 4, 1, 'performed_by'), edge(3, 3, 2, 'appears_on'), edge(4, 4, 2, 'appears_on')]
const graph: GraphData = { nodes, edges, loading: false, refetch: async () => undefined, byId: new Map(nodes.map((n) => [n.id, n])) }

const roots: Root[] = []

beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })),
  )
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const path = new URL(url, 'http://test').pathname
      const body = path.endsWith('/search')
        ? [
            { id: 1, type: 'artist', title: 'Dylan Moss' },
            { id: 2, type: 'release', title: 'Dylan Moss Live' },
          ]
        : path.endsWith('/playlists')
          ? []
          : path.endsWith('/summary')
            ? { releaseDate: '1966-05-16' }
            : null
      return { ok: true, json: async () => body }
    }),
  )
  Element.prototype.scrollIntoView = () => undefined
})

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()))
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

function fakePlayback(): Playback {
  return {
    playNode: vi.fn(async () => undefined),
    playAlbum: vi.fn(async () => undefined),
    playPlaylist: vi.fn(async () => undefined),
    playTracks: vi.fn(async () => undefined),
  } as unknown as Playback
}

async function search(query: string, playback: Playback, onClose = vi.fn()) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() =>
    root.render(
      createElement(
        GraphDataContext.Provider,
        { value: graph },
        createElement(SearchPalette, { onClose, onOpen: () => undefined, onOpenPlaylist: () => undefined, playback }),
      ),
    ),
  )
  const input = container.querySelector<HTMLInputElement>('input')!
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, query)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  // Past the search's debounce, and its answer.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200))
  })
  return { container, input, onClose }
}

describe('playing an artist from the search palette', () => {
  it("plays the artist's tracks as a queue named for them (#357)", async () => {
    const playback = fakePlayback()
    const { container, onClose } = await search('dyl', playback)
    const play = [...container.querySelectorAll('button')].find((b) => b.textContent === 'play')!
    act(() => play.click())
    expect(playback.playTracks).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 3, title: "Dylan's Dream" }), expect.objectContaining({ id: 4, title: 'Highway Blues' })],
      0,
      { kind: 'artist', nodeId: 1, name: 'Dylan Moss' },
    )
    expect(onClose).toHaveBeenCalled()
  })

  it('names the queue the same way from ⇧↵', async () => {
    const playback = fakePlayback()
    const { input } = await search('dyl', playback)
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }))
    })
    expect(playback.playTracks).toHaveBeenCalledWith(expect.any(Array), 0, { kind: 'artist', nodeId: 1, name: 'Dylan Moss' })
  })
})
