// @vitest-environment jsdom
//
// #464: the details panel's Metadata tab edits every tag the writer
// supports, for a track, an album and an artist, through the server's
// review step.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MetadataTab } from './NodeDetails'
import type { NodeDetail } from './useNodeDetail'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Call = { path: string; method: string; body: unknown }

let root: Root | null = null
let container: HTMLDivElement
let calls: Call[]
let formValues: Record<string, string>
let dryRun: Record<string, unknown>
let approved: Record<string, unknown>

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response

beforeEach(() => {
  calls = []
  dryRun = { noop: false, editId: 4, writeIds: [11], fileCount: 1, formats: ['FLAC'], skipped: [], merge: null }
  approved = { written: 1, failed: [], nodeId: 7 }
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }))
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname.replace('/api/v1', '')
      const method = init?.method ?? 'GET'
      calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (path.startsWith('/tag-writes/node/')) return json({ type: 'x', values: formValues })
      if (path.endsWith('/metadata')) return json({ releaseDate: null, releaseType: null, label: null, mbid: null })
      if (path === '/tag-writes' && method === 'POST') return json(dryRun)
      if (path.endsWith('/approve')) return json(approved)
      return json({})
    }),
  )
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container.remove()
  vi.unstubAllGlobals()
})

function node(type: string, id = 7): NodeDetail {
  return {
    id,
    type,
    title: 'Something',
    mbid: null,
    recording: type === 'recording' ? { canonical_duration_ms: 200000 } : null,
    files: [],
    edges: [],
    facts: [],
    article: null,
    description: null,
    playCount: null,
    is_favourite: false,
    releases: [],
  }
}

async function render(detail: NodeDetail, reload = vi.fn(), onOpenNode = vi.fn()) {
  root = createRoot(container)
  await act(async () => root!.render(<MetadataTab node={detail} summary={null} reload={reload} onOpenNode={onOpenNode} />))
  return { reload, onOpenNode }
}

const labels = () => [...container.querySelectorAll('dt')].map((dt) => dt.textContent)
const fields = () => [...container.querySelectorAll('input')].map((input) => input.getAttribute('aria-label'))

function button(name: string | RegExp): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((b) =>
    typeof name === 'string' ? b.textContent?.trim() === name : name.test(b.textContent ?? ''),
  )
  if (!found) throw new Error(`no button ${name}`)
  return found as HTMLButtonElement
}

async function click(name: string | RegExp) {
  await act(async () => button(name).click())
}

async function type(label: string, value: string) {
  const input = container.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const posted = () => calls.find((c) => c.path === '/tag-writes' && c.method === 'POST')?.body

describe('a track', () => {
  beforeEach(() => {
    formValues = {
      title: 'Come Together',
      artist: 'The Beatles',
      album: 'Abbey Road',
      albumArtist: 'The Beatles',
      releaseDate: '1969',
      trackNo: '1',
      discNo: '',
      genre: 'Rock',
      bpm: '',
      label: '',
      releaseType: '',
    }
  })

  it('shows and edits every field the writer supports', async () => {
    await render(node('recording'))
    expect(labels()).toEqual([
      'title',
      'artist',
      'album',
      'album artist',
      'release date',
      'track',
      'disc',
      'genre',
      'bpm',
      'label',
      'release type',
      'length',
      'mbid',
    ])
    await click('Edit')
    expect(fields()).toEqual([
      'title',
      'artist',
      'album',
      'album artist',
      'release date',
      'track',
      'disc',
      'genre',
      'bpm',
      'label',
      'release type',
    ])
    expect((container.querySelector('input[aria-label="title"]') as HTMLInputElement).value).toBe('Come Together')
  })

  it('reviews only what changed, typed as the server takes it, then writes it', async () => {
    const { reload } = await render(node('recording'))
    await click('Edit')
    await type('title', 'Come Together (Remastered)')
    await type('track', '3')
    await type('genre', 'Rock; Pop')
    await click('Review changes')

    expect(posted()).toEqual({ nodeId: 7, changes: { title: 'Come Together (Remastered)', trackNo: 3, genre: ['Rock', 'Pop'] } })
    expect(container.textContent).toContain('review before writing')
    expect(container.textContent).toContain('Writes tags to 1 FLAC file')

    await click('Write to 1 file')
    expect(calls.some((c) => c.path === '/tag-writes/edits/4/approve' && c.method === 'POST')).toBe(true)
    expect(reload).toHaveBeenCalled()
  })

  it("says what's wrong with a value instead of sending it", async () => {
    await render(node('recording'))
    await click('Edit')
    await type('bpm', 'fast')
    await click('Review change')
    expect(container.textContent).toContain('Bpm has to be a whole number.')
    expect(posted()).toBeUndefined()
  })

  it('discarding deletes the reviewed writes unwritten', async () => {
    await render(node('recording'))
    await click('Edit')
    await type('title', 'New')
    await click('Review change')
    await click('discard')
    expect(calls.some((c) => c.path === '/tag-writes/edits/4' && c.method === 'DELETE')).toBe(true)
    expect(calls.some((c) => c.path.endsWith('/approve'))).toBe(false)
  })
})

describe('an album', () => {
  beforeEach(() => {
    formValues = { album: 'Things We Lost', albumArtist: 'Low', releaseDate: '2001', genre: '', label: '', releaseType: 'album' }
  })

  it('edits its title, album artist, date, genre, label and type', async () => {
    await render(node('release'))
    await click('Edit')
    expect(fields()).toEqual(['title', 'album artist', 'release date', 'genre', 'label', 'release type'])
  })

  it('names the files it leaves out and why, and the album it merges into', async () => {
    dryRun = {
      ...dryRun,
      fileCount: 11,
      skipped: [
        { fileId: 3, path: '/music/Low/12 Closer.ogg', reason: "Legato can't write tags to Ogg files yet, only FLAC, MP3 and M4A" },
      ],
      merge: { id: 40, title: 'Things We Lost in the Fire' },
    }
    await render(node('release'))
    await click('Edit')
    await type('title', 'Things We Lost in the Fire')
    await click('Review change')

    expect(posted()).toEqual({ nodeId: 7, changes: { album: 'Things We Lost in the Fire' } })
    const text = container.textContent ?? ''
    expect(text).toContain('Leaves out 1 file')
    expect(text).toContain("Legato can't write tags to Ogg files yet, only FLAC, MP3 and M4A.")
    expect(text).toContain('12 Closer.ogg')
    expect(text).toContain('An album called Things We Lost in the Fire already exists, so this merges into it')
    expect(text).toContain('Writes tags to 11 FLAC files')
  })
})

describe('an artist', () => {
  beforeEach(() => {
    formValues = { name: 'Danny Brown' }
  })

  it('renames them, and opens the artist a merge left the edit on', async () => {
    dryRun = { ...dryRun, fileCount: 3, merge: { id: 99, title: 'Danny B.' } }
    approved = { written: 3, failed: [], nodeId: 99 }
    const { onOpenNode, reload } = await render(node('artist'))
    expect(labels()).toEqual(['name', 'mbid'])
    await click('Edit')
    expect(fields()).toEqual(['name'])
    expect(container.textContent).toContain('only their part changes')
    await type('name', 'Danny B.')
    await click('Review change')
    expect(posted()).toEqual({ nodeId: 7, changes: { name: 'Danny B.' } })
    expect(container.textContent).toContain('An artist called Danny B. already exists')

    await click('Write to 3 files')
    expect(onOpenNode).toHaveBeenCalledWith(99)
    expect(reload).not.toHaveBeenCalled()
  })

  it("says when nothing can be written because the files can't take it", async () => {
    dryRun = {
      noop: true,
      editId: null,
      writeIds: [],
      fileCount: 0,
      formats: [],
      skipped: [{ fileId: 1, path: '/music/a.wav', reason: "Legato can't write tags to WAV files yet, only FLAC, MP3 and M4A" }],
      merge: null,
    }
    await render(node('artist'))
    await click('Edit')
    await type('name', 'Someone')
    await click('Review change')
    expect(container.textContent).toContain("Nothing to write. These files can't take tag writes")
    expect(container.textContent).toContain('a.wav')
  })
})
