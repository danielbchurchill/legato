// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GraphDataContext, type GraphData } from '../canvas/graphContext'
import type { DetailsTab } from '../shell/panels'
import type { usePlayback } from '../playback/usePlayback'
import type { Edge, NodeDetail } from './useNodeDetail'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The node as GET /nodes/:id sends it, by id.
const details = vi.hoisted(() => ({ byId: new Map<number, NodeDetail>() }))

vi.mock('./useNodeDetail', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./useNodeDetail')>()
  return {
    ...actual,
    useNodeDetail: (id: number | null) => ({ node: id == null ? null : (details.byId.get(id) ?? null), reload: () => undefined }),
  }
})

import { NodeByline } from './NodeByline'
import { NodeDetails } from './NodeDetails'

type Playback = ReturnType<typeof usePlayback>

const edge = (other_id: number, other_title: string, other_type: string, type: string): Edge => ({
  id: other_id * 100,
  type,
  source: 'tags',
  label: null,
  note: null,
  direction: 'out',
  other_id,
  other_title,
  other_type,
})

function detail(patch: Partial<NodeDetail> & Pick<NodeDetail, 'id' | 'type' | 'title'>): NodeDetail {
  return {
    mbid: null,
    created_at: '2026-10-11 03:17:11',
    recording: null,
    files: [],
    edges: [],
    facts: [],
    article: null,
    description: null,
    playCount: null,
    is_favourite: false,
    releases: [],
    ...patch,
  }
}

const ALBUM = detail({ id: 2, type: 'release', title: 'Dylan Moss Live', edges: [edge(1, 'Dylan Moss', 'artist', 'performed_by')] })
const TRACK = detail({
  id: 3,
  type: 'recording',
  title: "Dylan's Dream",
  recording: { canonical_duration_ms: 27_000 },
  edges: [edge(1, 'Dylan Moss', 'artist', 'performed_by'), edge(2, 'Dylan Moss Live', 'release', 'appears_on')],
})

const graph: GraphData = { nodes: [], edges: [], loading: false, refetch: async () => undefined, byId: new Map() }

const roots: Root[] = []

beforeEach(() => {
  details.byId = new Map([ALBUM, TRACK].map((n) => [n.id, n]))
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })),
  )
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const path = new URL(url, 'http://test').pathname
      const body = path.endsWith('/credits') ? { tracks: [], people: [] } : path.endsWith('/summary') ? { kind: 'other' } : null
      return { ok: true, json: async () => body }
    }),
  )
})

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()))
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

function mount(element: ReturnType<typeof createElement>) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(element))
  return container
}

async function renderDetails(nodeId: number, tab: DetailsTab, onFocusNode: (id: number) => void) {
  const playback = { queueBusy: false } as unknown as Playback
  const container = mount(
    createElement(
      GraphDataContext.Provider,
      { value: graph },
      createElement(NodeDetails, { nodeId, tab, onTabChange: () => undefined, playback, onFocusNode }),
    ),
  )
  // The summary and credits.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return container
}

const button = (root: ParentNode, name: string) =>
  [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === name)
const byline = (container: HTMLElement) => container.querySelector('h2')!.nextElementSibling as HTMLElement

describe('a node byline (#451)', () => {
  it('reads "Artist · Album", each a link to its node', () => {
    const opened: number[] = []
    const container = mount(
      createElement(NodeByline, {
        artistName: 'Dylan Moss',
        artistId: 1,
        albumName: 'Dylan Moss Live',
        albumId: 2,
        onOpenNode: (id) => opened.push(id),
      }),
    )
    expect(container.textContent).toBe('Dylan Moss · Dylan Moss Live')
    act(() => button(container, 'Dylan Moss Live')!.click())
    act(() => button(container, 'Dylan Moss')!.click())
    expect(opened).toEqual([2, 1])
  })

  it('lets the album give way first, keeping the artist whole up to 70% of the line', () => {
    const container = mount(
      createElement(NodeByline, {
        artistName: 'The Quiet Engineers',
        artistId: 1,
        albumName: 'Signals',
        albumId: 2,
        onOpenNode: () => undefined,
      }),
    )
    const [artist, album] = container.querySelectorAll('button')
    expect(artist.className).toContain('shrink-0')
    expect(artist.className).toContain('max-w-[70%]')
    expect(album.className).not.toContain('shrink-0')
    expect(album.className).toContain('min-w-0')
  })

  it('reads the artist alone where there is no album', () => {
    const container = mount(createElement(NodeByline, { artistName: 'Dylan Moss', artistId: 1, onOpenNode: () => undefined }))
    expect(container.textContent).toBe('Dylan Moss')
    expect(container.querySelectorAll('button')).toHaveLength(1)
  })

  it('leaves a name with no node behind it as text', () => {
    const container = mount(
      createElement(NodeByline, {
        artistName: 'Dylan Moss',
        artistId: null,
        albumName: 'Dylan Moss Live',
        albumId: 2,
        onOpenNode: () => undefined,
      }),
    )
    expect(container.textContent).toBe('Dylan Moss · Dylan Moss Live')
    expect([...container.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Dylan Moss Live'])
  })

  it('draws nothing with neither', () => {
    const container = mount(createElement(NodeByline, { artistName: null, artistId: null, onOpenNode: () => undefined }))
    expect(container.innerHTML).toBe('')
  })

  it('takes taps across 44px in the sheet, truncating inside the button so the target survives', () => {
    const container = mount(
      createElement(NodeByline, {
        artistName: 'Dylan Moss',
        artistId: 1,
        albumName: 'Dylan Moss Live',
        albumId: 2,
        onOpenNode: () => undefined,
        sheet: true,
      }),
    )
    for (const link of container.querySelectorAll('button')) {
      expect(link.className).toContain('touch-target')
      expect(link.className).not.toContain('truncate')
      expect(link.className).not.toContain('hover:')
      expect(link.firstElementChild!.className).toContain('truncate')
    }
  })
})

describe("a track's article header on the desktop (#451)", () => {
  it.each(['overview', 'tracks'] as const)('reads "Artist · Album" under the title on the %s tab, and each opens its node', async (tab) => {
    const opened: number[] = []
    const container = await renderDetails(3, tab, (id) => opened.push(id))
    expect(container.querySelector('h2')?.textContent).toBe("Dylan's Dream")
    expect(byline(container).textContent).toBe('Dylan Moss · Dylan Moss Live')
    act(() => button(byline(container), 'Dylan Moss')!.click())
    act(() => button(byline(container), 'Dylan Moss Live')!.click())
    expect(opened).toEqual([1, 2])
  })

  it("keeps an album's header to its artist", async () => {
    const container = await renderDetails(2, 'overview', () => undefined)
    expect(byline(container).textContent).toBe('Dylan Moss')
  })
})
