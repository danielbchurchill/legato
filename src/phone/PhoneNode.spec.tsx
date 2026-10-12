// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GraphDataContext, type GraphData } from '../canvas/graphContext'
import type { Edge, NodeDetail } from '../panels/useNodeDetail'
import type { usePlayback } from '../playback/usePlayback'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The node as GET /nodes/:id sends it, by id.
const details = vi.hoisted(() => ({ byId: new Map<number, NodeDetail>() }))

vi.mock('../panels/useNodeDetail', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../panels/useNodeDetail')>()
  return {
    ...actual,
    useNodeDetail: (id: number | null) => ({ node: id == null ? null : (details.byId.get(id) ?? null), reload: () => undefined }),
  }
})

import { NodeBody, NodeControls, NodeHeader } from './PhoneNode'
import { usePhoneNode } from './nodeDetail'

type Playback = ReturnType<typeof usePlayback>

const edge = (other_id: number, other_title: string, other_type: string, type: string, direction: 'in' | 'out'): Edge => ({
  id: other_id * 100,
  type,
  source: 'tags',
  label: null,
  note: null,
  direction,
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

const ALBUM = detail({ id: 2, type: 'release', title: 'Dylan Moss Live', edges: [edge(1, 'Dylan Moss', 'artist', 'performed_by', 'out')] })
const TRACK = detail({
  id: 3,
  type: 'recording',
  title: "Dylan's Dream",
  recording: { canonical_duration_ms: 27_000 },
  edges: [edge(1, 'Dylan Moss', 'artist', 'performed_by', 'out'), edge(2, 'Dylan Moss Live', 'release', 'appears_on', 'out')],
})
const ARTIST = detail({ id: 1, type: 'artist', title: 'Dylan Moss' })
const CREDIT = detail({
  id: 5,
  type: 'credit',
  title: 'Dylan Hart',
  edges: [edge(3, "Dylan's Dream", 'recording', 'produced_by', 'in'), edge(4, 'Highway Blues', 'recording', 'produced_by', 'in')],
})

const graph: GraphData = { nodes: [], edges: [], loading: false, refetch: async () => undefined, byId: new Map() }

const roots: Root[] = []

beforeEach(() => {
  details.byId = new Map([ALBUM, TRACK, ARTIST, CREDIT].map((n) => [n.id, n]))
  // jsdom lays nothing out: the tabs' indicator watches for nothing.
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
      const body = path.endsWith('/2/summary')
        ? { kind: 'release', tracks: 2, totalDurationMs: 75_000, releaseDate: '1966-05-16' }
        : path.endsWith('/2/tracklist')
          ? [
              { id: 3, title: "Dylan's Dream", track_no: 1, canonical_duration_ms: 27_000 },
              { id: 4, title: 'Highway Blues', track_no: 2, canonical_duration_ms: 48_000 },
            ]
          : path.endsWith('/credits')
            ? { tracks: [], people: [] }
            : path.endsWith('/summary')
              ? { kind: 'other' }
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

function fakePlayback(): Playback {
  return {
    queueBusy: false,
    playAlbum: vi.fn(async () => undefined),
    playNode: vi.fn(async () => undefined),
    playTracks: vi.fn(async () => undefined),
    addToQueue: vi.fn(async () => undefined),
  } as unknown as Playback
}

function Detail({ id, playback, onOpenNode }: { id: number; playback: Playback; onOpenNode: (id: number) => void }) {
  const node = usePhoneNode(id, playback)
  return (
    <section>
      <NodeHeader node={node} playback={playback} onOpenNode={onOpenNode} />
      <NodeBody node={node} playback={playback} onOpenNode={onOpenNode} />
    </section>
  )
}

async function render(id: number, playback = fakePlayback(), onOpenNode: (id: number) => void = () => undefined) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(createElement(GraphDataContext.Provider, { value: graph }, createElement(Detail, { id, playback, onOpenNode })))
  })
  // The summary, tracklist and credits.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return container
}

const button = (root: ParentNode, name: string) =>
  [...root.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.getAttribute('aria-label') === name || b.textContent?.trim() === name,
  )

describe("a node's detail on the phone", () => {
  it('heads an album with its cover, kind and year, title and artist, then the actions and tabs', async () => {
    const container = await render(2)
    expect(container.querySelector('h2')?.textContent).toBe('Dylan Moss Live')
    expect(container.textContent).toContain('album · 1966')
    expect(button(container, 'Dylan Moss')).toBeDefined()
    expect(button(container, 'play')!.className).toContain('h-[44px]')
    expect(button(container, 'Add to favourites')).toBeDefined()
    expect(button(container, 'More')).toBeDefined()
    expect([...container.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toEqual(['overview', 'tracks', 'credits', 'metadata'])
  })

  it('lists the tracks in 44px rows and plays the album', async () => {
    const playback = fakePlayback()
    const container = await render(2, playback)
    const row = button(container, "1Dylan's Dream0:27")!
    expect(row.className).toContain('h-[44px]')
    act(() => button(container, 'play')!.click())
    expect(playback.playAlbum).toHaveBeenCalledWith(2)
  })

  it("opens the artist from the header, over this node's detail", async () => {
    const opened: number[] = []
    const container = await render(2, fakePlayback(), (id) => opened.push(id))
    act(() => button(container, 'Dylan Moss')!.click())
    expect(opened).toEqual([1])
  })

  it('offers add to queue and edit tags for a record, and edit tags opens the metadata tab', async () => {
    const playback = fakePlayback()
    const container = await render(2, playback)
    act(() => button(container, 'More')!.click())
    const menu = document.querySelector('[role="dialog"]')!
    expect([...menu.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['add to queue', 'edit tags'])
    act(() => button(menu, 'edit tags')!.click())
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('metadata')
  })

  it('offers add to playlist for a track, which turns the menu into the playlist picker', async () => {
    const container = await render(3)
    act(() => button(container, 'More')!.click())
    const menu = () => document.querySelector('[role="dialog"]')!
    expect([...menu().querySelectorAll('button')].map((b) => b.textContent)).toEqual(['add to queue', 'add to playlist', 'edit tags'])
    act(() => button(menu(), 'add to playlist')!.click())
    expect(menu().querySelector('input[aria-label="New playlist name"]')).not.toBeNull()
  })

  it('gives an artist a round photo and the heart alone', async () => {
    const container = await render(1)
    expect(container.querySelector('h2')?.textContent).toBe('Dylan Moss')
    expect(container.querySelector('.rounded-full img, .rounded-full')).not.toBeNull()
    expect(button(container, 'More')).toBeUndefined()
    expect(button(container, 'Add to favourites')).toBeDefined()
  })

  it("lists a producer's tracks and plays them, from the node's own credits", async () => {
    const playback = fakePlayback()
    const container = await render(5, playback)
    expect(container.textContent).toContain('producer')
    expect(container.querySelector('.bg-\\[var\\(--color-node-credit\\)\\]')).not.toBeNull()
    expect(container.textContent).toContain("Dylan's Dream")
    expect(container.textContent).toContain('Highway Blues')
    expect(button(container, 'More')).toBeUndefined()
    act(() => button(container, 'play')!.click())
    expect(playback.playTracks).toHaveBeenCalledWith([3, 4], 0, '')
  })
})

describe('the controls over the map in node detail', () => {
  it('goes back, centres the node, and takes the pill out of reach at large', () => {
    const onBack = vi.fn()
    const onCentre = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    act(() => root.render(createElement(NodeControls, { onBack, onCentre, pillHidden: true })))
    act(() => button(container, 'Back')!.click())
    act(() => button(container, 'centre on map')!.click())
    expect(onBack).toHaveBeenCalled()
    expect(onCentre).toHaveBeenCalled()
    expect(button(container, 'centre on map')!.parentElement!.hasAttribute('inert')).toBe(true)
  })
})
