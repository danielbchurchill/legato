// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LibraryView } from './LibraryView'
import { GraphDataContext, type GraphData } from '../canvas/graphContext'
import type { GraphNode } from '../canvas/useGraphData'
import type { usePlayback } from '../playback/usePlayback'
import type { ArtistRow } from './types'

/* #302: the Library header counted the map's graph, and GET /nodes stops at
 * 5,000 nodes. At 30,000 albums the header read "455 albums · 0 artists ·
 * 4,545 tracks" over an empty Artists tab. Here the graph is that capped
 * first 5,000, and the server knows the whole library. */

const STATS = { albums: 30_000, artists: 3_000, tracks: 300_000, totalBytes: 0, totalDurationMs: 0 }

// The first 5,000 nodes by id of the synthetic library, as GET /nodes sent
// them: every album's tracks ahead of the artists, so no artist at all.
function cappedGraph(): GraphData {
  const node = (id: number, type: string): GraphNode =>
    ({ id, type, title: `${type} ${id}`, mbid: null, canonical_duration_ms: null }) as GraphNode
  const nodes = Array.from({ length: 5_000 }, (_, i) => node(i + 1, i % 11 === 0 ? 'release' : 'recording'))
  return { nodes, edges: [], loading: false, refetch: async () => undefined, byId: new Map(nodes.map((n) => [n.id, n])) }
}

function artistsPage(url: URL): { items: ArtistRow[]; total: number } {
  const offset = Number(url.searchParams.get('offset'))
  const limit = Number(url.searchParams.get('limit'))
  const count = Math.max(0, Math.min(limit, STATS.artists - offset))
  return {
    items: Array.from({ length: count }, (_, i) => ({ id: 100_000 + offset + i, name: `Artist ${offset + i}`, releases: 10 })),
    total: STATS.artists,
  }
}

let root: Root | null = null

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = new URL(input)
      if (url.pathname.endsWith('/stats')) return Response.json(STATS)
      if (url.pathname.endsWith('/library/artists')) return Response.json(artistsPage(url))
      if (url.pathname.endsWith('/scan-jobs')) return Response.json([])
      return Response.json({ items: [], total: 0 })
    }),
  )
  vi.stubGlobal(
    'WebSocket',
    class {
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
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

async function render(graph: GraphData) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const playback = { playAlbum: vi.fn(), playNode: vi.fn(), status: { currentRecordingNodeId: null, playing: false } }
  await act(async () => {
    root = createRoot(container)
    root.render(
      createElement(
        GraphDataContext.Provider,
        { value: graph },
        createElement(LibraryView, {
          selectedNodeId: null,
          onOpenNode: () => undefined,
          playback: playback as unknown as ReturnType<typeof usePlayback>,
          settings: { libraryEntity: 'artists' },
          updateSettings: async () => undefined,
        }),
      ),
    )
  })
  // Let every fetch the first render started land.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return container
}

const countsLine = (container: HTMLElement) => container.querySelector('h1')?.nextElementSibling?.textContent

describe('Library header past the graph cap (#302)', () => {
  it("counts the whole library from the server, not the map's capped graph", async () => {
    const container = await render(cappedGraph())
    expect(countsLine(container)).toBe('30,000 albums · 3,000 artists · 300,000 tracks')
  })

  it('gives the same artist count as the Artists tab', async () => {
    const container = await render(cappedGraph())
    const heading = [...container.querySelectorAll('h2')].find((h) => h.textContent === 'All artists')
    expect(heading?.nextElementSibling?.textContent).toBe('3,000')
    expect(countsLine(container)).toContain('3,000 artists')
  })

  it('reads "Loading…" until the counts arrive, never the graph\'s', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => undefined)),
    )
    const container = await render(cappedGraph())
    expect(countsLine(container)).toBe('Loading…')
  })

  it("shows the counts as soon as /stats answers, while the map's graph is still loading", async () => {
    const container = await render({ ...cappedGraph(), nodes: [], byId: new Map(), loading: true })
    expect(countsLine(container)).toBe('30,000 albums · 3,000 artists · 300,000 tracks')
  })
})
