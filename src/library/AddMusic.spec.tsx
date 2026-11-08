// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AddMusic } from './AddMusic'
import { countParts, displayPath, suggestionName, type FolderSuggestion } from './folderSuggestions'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* First run's suggested folders (#132) against a fake server. */

const APPLE: FolderSuggestion = {
  path: '/Users/alex/Music/Music/Media.localized',
  kind: 'apple-music',
  audioFiles: 412,
  complete: true,
}
const NAS: FolderSuggestion = { path: '/mnt/music', kind: 'mount', audioFiles: 1000, complete: false }

let suggestions: { status: number; body: unknown }
let posted: unknown[]
let container: HTMLDivElement
let root: Root | null = null

const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response

beforeEach(() => {
  suggestions = { status: 200, body: { home: '/Users/alex', docker: false, suggestions: [APPLE, NAS] } }
  posted = []
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/fs/suggestions')) return json(suggestions.status, suggestions.body)
      if (url.endsWith('/library-roots') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { path: string }
        posted.push(body)
        return json(200, { id: 1, path: body.path, label: null })
      }
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

async function mount(onAdded = vi.fn()) {
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(AddMusic, { onAdded }))
  })
  for (let i = 0; i < 3; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
  return onAdded
}

const buttons = () => [...container.querySelectorAll('button')]

describe('AddMusic — suggested folders', () => {
  it('lists what the server found, each with its count, before the button', async () => {
    await mount()
    const rows = [...container.querySelectorAll('section[aria-label="Suggested folders"] li')].map((li) => li.textContent)
    expect(rows).toEqual(['Apple Music~/Music/Music/Media.localizedabout 412 tracks', 'music/mnt/music1,000+ tracks'])
    expect(buttons().at(-1)?.textContent).toBe('Choose another folder')
  })

  it('adds a suggestion through the normal add-folder request', async () => {
    const onAdded = await mount()
    const row = buttons().find((b) => b.textContent?.startsWith('Apple Music'))!
    await act(async () => row.click())
    expect(posted).toEqual([{ path: APPLE.path }])
    expect(onAdded).toHaveBeenCalledWith({ id: 1, path: APPLE.path, label: null })
  })

  it('keeps "Choose a folder" as the one way in when nothing was found', async () => {
    suggestions = { status: 200, body: { home: '/home/alex', docker: false, suggestions: [] } }
    await mount()
    expect(container.querySelector('section[aria-label="Suggested folders"]')).toBeNull()
    expect(buttons().map((b) => b.textContent)).toEqual(['Choose a folder'])
  })

  it("takes a refusal or an older server's 404 for no suggestions", async () => {
    suggestions = { status: 403, body: { error: 'owner only' } }
    await mount()
    expect(buttons().map((b) => b.textContent)).toEqual(['Choose a folder'])
  })
})

describe('folder suggestion wording', () => {
  it("names Music's and iTunes' media folders by their app, the rest by their own name", () => {
    expect(suggestionName(APPLE)).toBe('Apple Music')
    expect(suggestionName({ ...APPLE, kind: 'itunes', path: 'C:\\Users\\alex\\Music\\iTunes\\iTunes Media' })).toBe('iTunes')
    expect(suggestionName({ ...APPLE, kind: 'music', path: 'C:\\Users\\alex\\Music' })).toBe('Music')
    expect(suggestionName({ ...APPLE, kind: 'mount', path: '/media/alex/Backup' })).toBe('Backup')
  })

  it('writes the home directory as ~ on a Unix server only', () => {
    expect(displayPath('/home/alex/Music', '/home/alex')).toBe('~/Music')
    expect(displayPath('/home/alexandra/Music', '/home/alex')).toBe('/home/alexandra/Music')
    expect(displayPath('/mnt/music', '/home/alex')).toBe('/mnt/music')
    expect(displayPath('C:\\Users\\alex\\Music', 'C:\\Users\\alex')).toBe('C:\\Users\\alex\\Music')
    expect(displayPath('/music', null)).toBe('/music')
  })

  it('says "about" for a finished count and "+" for one that stopped early', () => {
    expect(countParts(APPLE)).toEqual({ before: 'about ', number: '412', after: ' tracks' })
    expect(countParts({ ...APPLE, audioFiles: 1 })).toEqual({ before: 'about ', number: '1', after: ' track' })
    expect(countParts(NAS)).toEqual({ before: '', number: '1,000+', after: ' tracks' })
    expect(countParts({ ...NAS, audioFiles: 1 })).toEqual({ before: '', number: '1+', after: ' tracks' })
  })
})
