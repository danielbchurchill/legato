// @vitest-environment jsdom
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MetadataGaps } from './MetadataGaps'
import { DEFAULT_GAP_VIEW, type GapAlbum, type GapFile, type GapTrack, type GapView } from './healthData'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* #469: the gaps list grouped by album, filtered by kind and artist,
 * sorted, paged, and filled for a whole album through tag writes. */

const MBID = 'b84ee12a-09ef-421b-82de-0441a926375b'

function album(id: number | null, over: Partial<GapAlbum> = {}): GapAlbum {
  return {
    id,
    title: id == null ? null : `Album ${id}`,
    artist: id == null ? null : 'The Beatles',
    tracks: 2,
    gaps: 3,
    byKind: { unmatched: 0, label: 2, release_date: 1, release_type: 0 },
    plays: 0,
    releaseMbid: null,
    ...over,
  }
}

let server: {
  total: number
  albums: GapAlbum[]
  tracks: GapTrack[]
  files: GapFile[]
}
const requests: { method: string; path: string; body: unknown }[] = []

function respond(path: string, method: string, body: unknown): unknown {
  const url = new URL(path, 'http://x')
  const offset = Number(url.searchParams.get('offset') ?? 0)
  const limit = Number(url.searchParams.get('limit') ?? 50)
  if (url.pathname === '/tag-manager/counts') return { unmatched: 4, label: 120, release_date: 30, release_type: 9, bpm: 2000 }
  if (url.pathname === '/tag-manager/albums') return { total: server.total, items: server.albums.slice(offset, offset + limit) }
  if (/^\/tag-manager\/albums\/[^/]+\/tracks$/.test(url.pathname))
    return { total: server.tracks.length, items: server.tracks.slice(offset, offset + limit) }
  if (/^\/tag-manager\/albums\/\d+\/files$/.test(url.pathname)) return server.files
  if (url.pathname === '/tag-writes' && method === 'POST') {
    const { fileId, changes } = body as { fileId: number; changes: Record<string, string> }
    const diff = Object.entries(changes).map(([field, newValue]) => ({ field, oldValue: '', newValue }))
    return { id: 500 + fileId, file_id: fileId, status: 'pending_review', diff_json: JSON.stringify(diff) }
  }
  return {}
}

const roots: Root[] = []

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  requests.length = 0
  server = { total: 2, albums: [album(7, { releaseMbid: MBID }), album(null, { gaps: 1, tracks: 1 })], tracks: [], files: [] }
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }))
  vi.stubGlobal(
    'WebSocket',
    class {
      static CLOSED = 3
      readyState = 0
      close() {}
    },
  )
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const { pathname, search } = new URL(url)
      const path = pathname.replace('/api/v1', '') + search
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(init.body as string) : null
      requests.push({ method, path, body })
      return { ok: true, status: 200, json: async () => respond(path, method, body) } as Response
    }),
  )
})

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()))
  vi.unstubAllGlobals()
  vi.useRealTimers()
  document.body.innerHTML = ''
})

const settle = () => act(async () => vi.advanceTimersByTimeAsync(0))

/* The list as its panel holds it: the view lives outside, as HealthPanel's does. */
async function render(initial: GapView = DEFAULT_GAP_VIEW) {
  const views: GapView[] = []
  function Host() {
    const [view, setView] = useState(initial)
    views.push(view)
    return createElement(MetadataGaps, { view, onViewChange: setView, onFocusNode: () => undefined })
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => root.render(createElement(Host)))
  await settle()
  return { container, views }
}

const gets = (prefix: string) => requests.filter((r) => r.method === 'GET' && r.path.startsWith(prefix)).map((r) => r.path)
const button = (container: HTMLElement, text: string | RegExp) =>
  [...container.querySelectorAll('button')].find((b) =>
    typeof text === 'string' ? b.textContent === text : text.test(b.textContent ?? ''),
  )!

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('MetadataGaps', () => {
  it('asks for the first page of albums with every kind but BPM, most gaps first, and counts from one request', async () => {
    const { container } = await render()
    expect(gets('/tag-manager/albums')).toEqual([
      '/tag-manager/albums?kinds=unmatched%2Clabel%2Crelease_date%2Crelease_type&sort=gaps&dir=desc&offset=0&limit=50',
    ])
    expect(gets('/tag-manager/counts')).toEqual(['/tag-manager/counts'])
    expect(gets('/tag-manager?field')).toEqual([])
    // An album to a row, its gaps summed, and the tracks with no album last.
    const rows = [...container.querySelectorAll('li > button[aria-expanded]')].map((b) => b.textContent)
    expect(rows).toEqual(['Album 7The Beatles3', 'No albumtracks with no album tag1'])
    // BPM's chip is there, off.
    const bpm = button(container, /^bpm/)
    expect(bpm.getAttribute('aria-pressed')).toBe('false')
    expect(bpm.textContent).toBe('bpm2,000')
    expect(button(container, /^label/).getAttribute('aria-pressed')).toBe('true')
  })

  it('filters by kind: a chip adds or removes its kind', async () => {
    const { container, views } = await render()
    await act(async () => button(container, /^bpm/).click())
    await settle()
    expect(views.at(-1)!.kinds).toEqual(['unmatched', 'label', 'release_date', 'release_type', 'bpm'])
    expect(gets('/tag-manager/albums').at(-1)).toContain('kinds=unmatched%2Clabel%2Crelease_date%2Crelease_type%2Cbpm')
    await act(async () => button(container, /^label/).click())
    await settle()
    expect(views.at(-1)!.kinds).toEqual(['unmatched', 'release_date', 'release_type', 'bpm'])
  })

  it('filters by artist once the typing pauses', async () => {
    const { container } = await render()
    const search = container.querySelector<HTMLInputElement>('input[aria-label="Filter by artist"]')!
    await act(async () => type(search, 'beat'))
    await act(async () => vi.advanceTimersByTimeAsync(100))
    expect(gets('/tag-manager/albums').some((p) => p.includes('artist='))).toBe(false)
    await act(async () => vi.advanceTimersByTimeAsync(300))
    await settle()
    expect(gets('/tag-manager/albums').at(-1)).toContain('artist=beat')
    expect(gets('/tag-manager/counts').at(-1)).toBe('/tag-manager/counts?artist=beat')
  })

  it('sorts by what the view says, ascending or descending', async () => {
    await render({ ...DEFAULT_GAP_VIEW, sort: 'plays', dir: 'desc' })
    expect(gets('/tag-manager/albums').at(-1)).toContain('sort=plays&dir=desc')
    await render({ ...DEFAULT_GAP_VIEW, sort: 'artist', dir: 'asc' })
    expect(gets('/tag-manager/albums').at(-1)).toContain('sort=artist&dir=asc')
  })

  it('pages: shows the first 50 and asks for the next 50 on "Show more albums"', async () => {
    server.albums = Array.from({ length: 120 }, (_, i) => album(i + 1))
    server.total = 120
    const { container } = await render()
    expect(container.querySelectorAll('li > button[aria-expanded]')).toHaveLength(50)
    expect(container.textContent).toContain('50 of 120')
    await act(async () => button(container, 'Show more albums').click())
    await settle()
    expect(gets('/tag-manager/albums').at(-1)).toContain('offset=50&limit=50')
    expect(container.querySelectorAll('li > button[aria-expanded]')).toHaveLength(100)
  })

  it('opens an album to its tracks, a value for the album and where to look it up', async () => {
    server.tracks = [
      {
        id: 11,
        title: 'Come Together',
        artist: 'The Beatles',
        discNo: 1,
        trackNo: 1,
        missing: ['label', 'release_date'],
        plays: 0,
        files: [{ id: 21, missing: ['label', 'release_date'] }],
      },
      {
        id: 12,
        title: 'Something',
        artist: 'The Beatles',
        discNo: 1,
        trackNo: 2,
        missing: ['label'],
        plays: 0,
        files: [{ id: 22, missing: ['label'] }],
      },
    ]
    const { container } = await render()
    await act(async () => button(container, /^Album 7/).click())
    await settle()
    expect(gets('/tag-manager/albums/7/tracks')).toEqual([
      '/tag-manager/albums/7/tracks?kinds=unmatched%2Clabel%2Crelease_date%2Crelease_type&offset=0&limit=100',
    ])
    expect(container.textContent).toContain('Come Together')
    expect(container.textContent).toContain('no label · no release date')
    const links = Object.fromEntries([...container.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')]))
    expect(links['MusicBrainz release']).toBe(`https://musicbrainz.org/release/${MBID}`)
    expect(links['Open in Picard']).toBe(`http://127.0.0.1:8000/openalbum?id=${MBID}`)
    expect(links['Search Discogs']).toContain('https://www.discogs.com/search/')
    for (const a of container.querySelectorAll('a')) expect(a.getAttribute('target')).toBe('_blank')
    expect(container.textContent).toContain("Picard is MusicBrainz's free tagger")
    // Label and release date are this album's to fill; type isn't missing.
    expect(container.querySelector('input[aria-label="label for the album"]')).not.toBeNull()
    expect(container.querySelector('input[aria-label="release date for the album"]')).not.toBeNull()
    expect(container.querySelector('input[aria-label="type for the album"]')).toBeNull()
  })

  it('fills a value for every track on the album missing it, through one review, then writes it', async () => {
    server.tracks = []
    server.files = [
      { id: 21, trackId: 11, missing: ['label', 'release_date'] },
      { id: 22, trackId: 12, missing: ['release_date'] },
      { id: 23, trackId: 13, missing: ['label'] },
    ]
    const { container } = await render()
    await act(async () => button(container, /^Album 7/).click())
    await settle()
    await act(async () => type(container.querySelector<HTMLInputElement>('input[aria-label="label for the album"]')!, 'Apple'))
    await act(async () => button(container, 'Review changes').click())
    await settle()

    const posts = requests.filter((r) => r.method === 'POST' && r.path === '/tag-writes').map((r) => r.body)
    // One dry run per file that lacks the label; the one that has it is left alone.
    expect(posts).toEqual([
      { fileId: 21, changes: { label: 'Apple' } },
      { fileId: 23, changes: { label: 'Apple' } },
    ])
    expect(container.textContent).toContain('label›Appleon 2 files')
    await act(async () => button(container, 'Write to 2 files').click())
    await settle()
    expect(requests.filter((r) => r.path.endsWith('/approve')).map((r) => r.path)).toEqual([
      '/tag-writes/521/approve',
      '/tag-writes/523/approve',
    ])
    expect(container.textContent).toContain('Written to 2 files.')
  })

  it('discards the proposed writes without writing any', async () => {
    server.files = [{ id: 21, trackId: 11, missing: ['label'] }]
    const { container } = await render()
    await act(async () => button(container, /^Album 7/).click())
    await settle()
    await act(async () => type(container.querySelector<HTMLInputElement>('input[aria-label="label for the album"]')!, 'Apple'))
    await act(async () => button(container, 'Review changes').click())
    await settle()
    await act(async () => button(container, 'Discard').click())
    await settle()
    expect(requests.filter((r) => r.method === 'DELETE').map((r) => r.path)).toEqual(['/tag-writes/521'])
    expect(requests.some((r) => r.path.endsWith('/approve'))).toBe(false)
  })

  it('refuses a value that isn’t a date before asking the server', async () => {
    const { container } = await render()
    await act(async () => button(container, /^Album 7/).click())
    await settle()
    await act(async () => type(container.querySelector<HTMLInputElement>('input[aria-label="release date for the album"]')!, 'last year'))
    await act(async () => button(container, 'Review changes').click())
    await settle()
    expect(container.textContent).toContain("That doesn't look like a release date.")
    expect(requests.some((r) => r.path.includes('/files'))).toBe(false)
  })

  it('edits a single track on its own, writing each of its files that lacks the value', async () => {
    server.tracks = [
      {
        id: 11,
        title: 'Come Together',
        artist: null,
        discNo: null,
        trackNo: 1,
        missing: ['label'],
        plays: 0,
        files: [
          { id: 21, missing: ['label'] },
          { id: 31, missing: ['label'] },
        ],
      },
    ]
    const { container } = await render()
    await act(async () => button(container, /^Album 7/).click())
    await settle()
    await act(async () => button(container, 'add').click())
    await act(async () => type(container.querySelector<HTMLInputElement>('input[aria-label="label"]')!, 'Apple'))
    await act(async () => button(container, 'Save').click())
    await settle()
    expect(requests.filter((r) => r.method === 'POST' && r.path === '/tag-writes').map((r) => r.body)).toEqual([
      { fileId: 21, changes: { label: 'Apple' } },
      { fileId: 31, changes: { label: 'Apple' } },
    ])
    expect(container.textContent).toContain('in Tag writes')
  })

  it('offers no album-wide value or links for the tracks with no album', async () => {
    server.tracks = [
      {
        id: 11,
        title: 'Loose',
        artist: null,
        discNo: null,
        trackNo: null,
        missing: ['label'],
        plays: 0,
        files: [{ id: 21, missing: ['label'] }],
      },
    ]
    const { container } = await render()
    await act(async () => button(container, /^No album/).click())
    await settle()
    expect(gets('/tag-manager/albums/none/tracks')).toHaveLength(1)
    expect(container.querySelector('input[aria-label$="for the album"]')).toBeNull()
    expect(container.querySelectorAll('a')).toHaveLength(0)
    expect(container.textContent).toContain('Loose')
  })
})
