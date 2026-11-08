// @vitest-environment jsdom
//
// #357: playing an artist from the desktop's node details names the queue
// for the artist, as Shuffle library names its own (#345), so up next can
// say where the music came from.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GraphDataContext, type GraphData } from '../canvas/graphContext'
import type { GraphNode } from '../canvas/useGraphData'
import type { usePlayback } from '../playback/usePlayback'
import type { NodeDetail } from './useNodeDetail'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The node as GET /nodes/:id sends it, by id.
const details = vi.hoisted(() => ({ byId: new Map<number, unknown>() }))

vi.mock('./useNodeDetail', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./useNodeDetail')>()
  return {
    ...actual,
    useNodeDetail: (id: number | null) => ({ node: id == null ? null : (details.byId.get(id) ?? null), reload: () => undefined }),
  }
})

import { NodeDetails } from './NodeDetails'

type Playback = ReturnType<typeof usePlayback>

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

const ARTIST = detail({ id: 1, type: 'artist', title: 'Dylan Moss' })
const ALBUM = detail({ id: 2, type: 'release', title: 'Dylan Moss Live' })

const track = (id: number, title: string) => ({ id, type: 'recording', title }) as GraphNode
const graphNodes = [track(3, "Dylan's Dream"), track(4, 'Highway Blues')]
const graph: GraphData = {
  nodes: graphNodes,
  edges: [],
  loading: false,
  refetch: async () => undefined,
  byId: new Map(graphNodes.map((n) => [n.id, n])),
}

const roots: Root[] = []

beforeEach(() => {
  details.byId = new Map([ARTIST, ALBUM].map((n) => [n.id, n]))
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
      // The artist's tracks and the record's, by id, as /credits names
      // them.
      const body = path.endsWith('/credits')
        ? { tracks: [3, 4], people: [] }
        : path.endsWith('/2/tracklist')
          ? [
              { id: 3, title: "Dylan's Dream", track_no: 1, canonical_duration_ms: 27_000 },
              { id: 4, title: 'Highway Blues', track_no: 2, canonical_duration_ms: 48_000 },
            ]
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
  } as unknown as Playback
}

async function render(nodeId: number, playback: Playback) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() =>
    root.render(
      createElement(
        GraphDataContext.Provider,
        { value: graph },
        createElement(NodeDetails, { nodeId, tab: 'overview', onTabChange: () => undefined, playback, onFocusNode: () => undefined }),
      ),
    ),
  )
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return container
}

const button = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)

describe("an artist's details on the desktop", () => {
  it("plays the artist's tracks as a queue named for them", async () => {
    const playback = fakePlayback()
    const container = await render(1, playback)
    act(() => button(container, 'play')!.click())
    expect(playback.playTracks).toHaveBeenCalledWith(
      [
        { id: 3, title: "Dylan's Dream" },
        { id: 4, title: 'Highway Blues' },
      ],
      0,
      { kind: 'artist', nodeId: 1, name: 'Dylan Moss' },
    )
  })

  it('names the queue the same way when it shuffles them', async () => {
    const playback = fakePlayback()
    const container = await render(1, playback)
    act(() => button(container, 'shuffle')!.click())
    expect(playback.playTracks).toHaveBeenCalledWith(expect.arrayContaining([{ id: 3, title: "Dylan's Dream" }]), 0, {
      kind: 'artist',
      nodeId: 1,
      name: 'Dylan Moss',
    })
  })

  it("still names a record's shuffled queue for the record", async () => {
    const playback = fakePlayback()
    const container = await render(2, playback)
    act(() => button(container, 'shuffle')!.click())
    expect(playback.playTracks).toHaveBeenCalledWith(expect.any(Array), 0, { kind: 'release', nodeId: 2 })
  })
})
