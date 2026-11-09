// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOWNLOAD_HELP_URL, type Preview, type Result } from './AppleMusicImport'
import { ImportPlaylist } from './ImportPlaylist'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* Apple Music's Library.xml through Collections' import page (#133),
 * against a fake server. */

const PREVIEW: Preview = {
  tracks: 9,
  matchedByLocation: 4,
  matchedByMetadata: 2,
  notFound: 1,
  cloudOnly: 2,
  setAside: 3,
  remaps: [{ from: '/Volumes/Archive/Music Media/Music/', to: '/mnt/music/', tracks: 4 }],
  plays: { tracks: 5, total: 28 },
  ratings: 2,
  datesAdded: 6,
  playlists: [
    { name: 'Road Trip', tracks: 4, matched: 2, status: 'new' },
    { name: 'Old Mix', tracks: 3, matched: 3, status: 'already-imported' },
  ],
  skippedPlaylists: { smart: 1, builtIn: 4, folders: 1 },
}

const RESULT: Result = {
  ...PREVIEW,
  playlists: [
    { name: 'Road Trip', tracks: 4, matched: 2, status: 'new', playlistId: 41 },
    { name: 'Old Mix', tracks: 3, matched: 3, status: 'already-imported', playlistId: null },
  ],
  cloudOnlyTracks: [
    { name: 'Paper Moon Waltz', artist: 'Elsie Varga', album: 'Ballroom Tapes', location: null },
    { name: 'Glass Harbour', artist: 'Northbound Signal', album: 'Static Bloom', location: null },
  ],
  notFoundTracks: [{ name: 'Unheard Thing', artist: 'Northbound Signal', album: 'Static Bloom', location: '/Volumes/x.mp3' }],
}

let requests: { url: string; init?: RequestInit }[]
let previewStatus: number
let container: HTMLDivElement
let root: Root | null = null

const json = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body }) as Response

beforeEach(() => {
  requests = []
  previewStatus = 200
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, init })
      if (url.endsWith('/apple-music/import/preview')) {
        return previewStatus === 200
          ? json(200, PREVIEW)
          : json(previewStatus, { error: "This isn't a Library.xml Music could have written." })
      }
      if (url.includes('/apple-music/import?')) return json(200, RESULT)
      if (url.endsWith('/playlists')) return json(200, [])
      return json(404, {})
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

async function settle() {
  for (let i = 0; i < 4; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
}

async function pickLibrary(onOpenPlaylist = vi.fn()) {
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(ImportPlaylist, { onBack: vi.fn(), onOpenPlaylist }))
  })
  const input = container.querySelector('input[type="file"]') as HTMLInputElement
  const file = new File(['<plist/>'], 'Library.xml', { type: 'text/xml' })
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
  await settle()
  return { file, onOpenPlaylist }
}

const button = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === text)!

describe('importing a Library.xml', () => {
  it('takes it on the playlist import page and sends the file itself as XML', async () => {
    const { file } = await pickLibrary()
    const sent = requests.find((r) => r.url.endsWith('/apple-music/import/preview'))!
    expect(sent.init?.method).toBe('POST')
    expect((sent.init?.headers as Record<string, string>)['Content-Type']).toBe('application/xml')
    expect(sent.init?.body).toBe(file)
    expect(container.textContent).toContain('Import from Apple Music')
  })

  it('previews what it found and what comes over before anything is written', async () => {
    await pickLibrary()
    const text = container.textContent!
    expect(text).toContain('4 by location')
    expect(text).toContain('2 by artist and title')
    expect(text).toContain('2 in the cloud only')
    expect(text).toContain('1 not found')
    expect(text).toContain('/Volumes/Archive/Music Media/Music/ → /mnt/music/')
    expect(text).toContain('28 plays on 5 tracks')
    expect(text).toContain('Road Trip2 of 4 tracks')
    expect(text).toContain('Old Mixalready imported')
    expect(requests.some((r) => r.url.includes('/apple-music/import?'))).toBe(false)
  })

  it('imports, then lists the cloud-only tracks with how to download them', async () => {
    const { onOpenPlaylist } = await pickLibrary()
    await act(async () => button('Import').click())
    await settle()
    expect(requests.some((r) => r.url.endsWith('/apple-music/import?filename=Library.xml'))).toBe(true)

    const text = container.textContent!
    expect(text).toContain('Imported from Apple Music')
    expect(text).toContain('Paper Moon Waltz')
    expect(text).toContain('Glass Harbour')
    expect(text).toContain('not downloaded to the Mac it came from')
    const link = [...container.querySelectorAll('a')].find((a) => a.textContent === 'How to download music in Music')!
    expect(link.href).toBe(DOWNLOAD_HELP_URL)
    expect(link.target).toBe('_blank')
    expect(text).toContain('Unheard Thing')

    await act(async () => button('Open').click())
    expect(onOpenPlaylist).toHaveBeenCalledWith(41)
  })

  it("says why when the file isn't a Music library", async () => {
    previewStatus = 400
    await pickLibrary()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("This isn't a Library.xml Music could have written.")
    expect(button('Import')).toBeUndefined()
  })
})
