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

// What the fake server answers with, which a test changes to stand for a
// rescan or a merge, and how often it was asked.
let server: { stats: typeof STATS; statsStatus: number; statsUnreachable: boolean; artistsStatus: number }
let requests: Record<string, number>

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
  const total = server.stats.artists
  const count = Math.max(0, Math.min(limit, total - offset))
  return {
    items: Array.from({ length: count }, (_, i) => ({ id: 100_000 + offset + i, name: `Artist ${offset + i}`, releases: 10 })),
    total,
  }
}

// Every socket the view opened, to send server events through.
let sockets: { onmessage: ((msg: { data: string }) => void) | null }[]

function send(event: string, payload: unknown = {}) {
  for (const socket of sockets) socket.onmessage?.({ data: JSON.stringify({ event, payload }) })
}

// What the server sends after a recompute or a merge, with its revision.
let revision = 1_000
function libraryChanged(at = ++revision) {
  send('library:changed', { revision: at })
}

let root: Root | null = null

beforeEach(() => {
  server = { stats: STATS, statsStatus: 200, statsUnreachable: false, artistsStatus: 200 }
  requests = {}
  sockets = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = new URL(input)
      const route = url.pathname.replace(/^.*\/api\/v1/, '')
      requests[route] = (requests[route] ?? 0) + 1
      if (route === '/stats') {
        if (server.statsUnreachable) throw new TypeError('Failed to fetch')
        return Response.json(server.stats, { status: server.statsStatus })
      }
      if (route === '/library/artists') {
        return server.artistsStatus === 200 ? Response.json(artistsPage(url)) : Response.json({ error: 'nope' }, { status: server.artistsStatus })
      }
      if (route === '/scan-jobs') return Response.json([])
      return Response.json({ items: [], total: 0 })
    }),
  )
  vi.stubGlobal(
    'WebSocket',
    class {
      onmessage: ((msg: { data: string }) => void) | null = null
      constructor() {
        sockets.push(this)
      }
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
  vi.useRealTimers()
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
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0)
    else await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return container
}

const countsLine = (container: HTMLElement) => container.querySelector('h1')?.nextElementSibling?.textContent
const tabCount = (container: HTMLElement) =>
  [...container.querySelectorAll('h2')].find((h) => h.textContent === 'All artists')?.nextElementSibling?.textContent

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

describe('Library header and Artists tab after the library changes (#302)', () => {
  // A merge took one artist away.
  function changeLibrary() {
    server.stats = { ...STATS, artists: 2_999 }
  }

  it('fetches both again after library:changed, so they agree', async () => {
    const container = await render(cappedGraph())
    vi.useFakeTimers()

    changeLibrary()
    await act(async () => {
      libraryChanged()
      await vi.advanceTimersByTimeAsync(1_500)
    })

    expect(requests).toMatchObject({ '/stats': 2, '/library/artists': 2 })
    expect(countsLine(container)).toBe('30,000 albums · 2,999 artists · 300,000 tracks')
    expect(tabCount(container)).toBe('2,999')
  })

  // The watcher sends scan:file for every file it reads, and the enrichment
  // worker sends enrich:applied and hygiene:changed for every job, every few
  // seconds for as long as a drain lasts. None of them rewrites the albums.
  for (const event of ['scan:file', 'enrich:applied', 'hygiene:changed', 'scan:done']) {
    it(`doesn't fetch on ${event}`, async () => {
      const container = await render(cappedGraph())
      vi.useFakeTimers()

      changeLibrary()
      await act(async () => {
        for (let i = 0; i < 300; i++) {
          send(event)
          await vi.advanceTimersByTimeAsync(2_500)
        }
      })

      expect(requests).toMatchObject({ '/stats': 1, '/library/artists': 1 })
      expect(countsLine(container)).toBe('30,000 albums · 3,000 artists · 300,000 tracks')
    })
  }

  it('fetches once for a burst of changes that goes quiet', async () => {
    await render(cappedGraph())
    vi.useFakeTimers()

    await act(async () => {
      for (let i = 0; i < 5; i++) {
        libraryChanged()
        await vi.advanceTimersByTimeAsync(1_000)
      }
      await vi.advanceTimersByTimeAsync(1_500)
    })

    expect(requests).toMatchObject({ '/stats': 2, '/library/artists': 2 })
  })

  it("fetches every 10 s while changes don't stop, rather than waiting for them to", async () => {
    await render(cappedGraph())
    vi.useFakeTimers()

    // One act a second, so each fetch renders before the next event.
    for (let i = 0; i < 30; i++) {
      await act(async () => {
        libraryChanged()
        await vi.advanceTimersByTimeAsync(1_000)
      })
    }

    expect(requests).toMatchObject({ '/stats': 4, '/library/artists': 4 })
  })

  it("doesn't fetch for a revision it has already fetched", async () => {
    await render(cappedGraph())
    vi.useFakeTimers()

    await act(async () => {
      libraryChanged(2_000)
      await vi.advanceTimersByTimeAsync(1_500)
      libraryChanged(2_000)
      libraryChanged(1_999)
      await vi.advanceTimersByTimeAsync(1_500)
    })

    expect(requests).toMatchObject({ '/stats': 2, '/library/artists': 2 })
  })

  for (const status of [500, 401]) {
    it(`keeps what both show when a refetch answers ${status}`, async () => {
      const container = await render(cappedGraph())
      vi.useFakeTimers()

      server.statsStatus = status
      server.artistsStatus = status
      await act(async () => {
        libraryChanged()
        await vi.advanceTimersByTimeAsync(1_500)
      })

      expect(requests).toMatchObject({ '/stats': 2, '/library/artists': 2 })
      expect(countsLine(container)).toBe('30,000 albums · 3,000 artists · 300,000 tracks')
      expect(tabCount(container)).toBe('3,000')
      // A refetch that failed isn't tried again: the counts are there.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000)
      })
      expect(requests['/stats']).toBe(2)
    })
  }
})

describe("Library header when /stats doesn't answer at first (#302)", () => {
  // Nothing else would fetch it again: the next library:changed may be days
  // away on a library that's caught up, and the socket doesn't reconnect.
  for (const failure of ['500', 'network'] as const) {
    it(`tries again after 1, 2, 4… s, then every 30 s, until it answers (${failure})`, async () => {
      vi.useFakeTimers()
      if (failure === '500') server.statsStatus = 500
      else server.statsUnreachable = true
      const container = await render(cappedGraph())
      expect(countsLine(container)).toBe('Loading…')
      expect(requests['/stats']).toBe(1)

      const after = async (ms: number) =>
        act(async () => {
          await vi.advanceTimersByTimeAsync(ms)
        })
      // 1 + 2 + 4 + 8 + 16 s, then 30 s at a time.
      await after(1_000)
      expect(requests['/stats']).toBe(2)
      await after(2_000 + 4_000 + 8_000 + 16_000)
      expect(requests['/stats']).toBe(6)
      await after(29_000)
      expect(requests['/stats']).toBe(6)
      await after(1_000)
      expect(requests['/stats']).toBe(7)
      expect(countsLine(container)).toBe('Loading…')

      server.statsStatus = 200
      server.statsUnreachable = false
      await after(30_000)
      expect(requests['/stats']).toBe(8)
      expect(countsLine(container)).toBe('30,000 albums · 3,000 artists · 300,000 tracks')
      await after(120_000)
      expect(requests['/stats']).toBe(8)
    })
  }
})
