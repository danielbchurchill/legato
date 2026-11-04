// @vitest-environment jsdom
//
// #461: choosing an album's cover from the Cover Art Archive, Deezer or
// your own image.
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CoverArt } from '../ui/CoverArt'
import { ChangeCover, CoverPicker } from './CoverPicker'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ALBUM = 20
const TRACK = 21
const CD = '02ac7ce7-4f21-4010-8210-e682085c58ab'

type PickerState = { online: boolean; searchable: boolean; manual: boolean; title: string | null; artist: string | null; nodeIds: number[] }

let picker: PickerState
let caa: unknown
let deezer: unknown
let caaAll: unknown
let root: Root | null = null
let container: HTMLDivElement

function ok(body: unknown, status = 200): Response {
  return { ok: true, status, json: async () => body } as Response
}

beforeEach(() => {
  picker = { online: true, searchable: true, manual: false, title: 'Rumours', artist: 'Fleetwood Mac', nodeIds: [ALBUM, TRACK] }
  caa = {
    source: 'caa',
    match: { title: 'Rumours', artist: 'Fleetwood Mac' },
    candidates: [
      { id: `caa:${CD}:front`, source: 'caa', kind: 'front', edition: '1977 · US' },
      { id: `caa:${CD}:back`, source: 'caa', kind: 'back', edition: '1977 · US' },
    ],
    more: 3,
  }
  caaAll = {
    source: 'caa',
    match: { title: 'Rumours', artist: 'Fleetwood Mac' },
    candidates: [
      { id: `caa:${CD}:front`, source: 'caa', kind: 'front', edition: '1977 · US' },
      { id: `caa:${CD}:back`, source: 'caa', kind: 'back', edition: '1977 · US' },
      { id: `caa:${CD}:41`, source: 'caa', kind: 'booklet', edition: '1977 · US' },
    ],
    more: 0,
  }
  deezer = {
    source: 'deezer',
    match: { title: 'Rumours', artist: 'Fleetwood Mac' },
    candidates: [{ id: `deezer:${'9'.repeat(32)}`, source: 'deezer', kind: 'front', edition: 'Rumours (Super Deluxe) · 58 tracks' }],
    more: 0,
  }
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }))
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const { pathname, searchParams } = new URL(url)
      const path = pathname.replace('/api/v1', '')
      if (path === `/nodes/${ALBUM}/cover/picker`) return ok(picker)
      if (path === `/nodes/${ALBUM}/cover/candidates`) {
        if (searchParams.get('source') === 'deezer') return ok(deezer)
        return ok(searchParams.get('all') === '1' ? caaAll : caa)
      }
      if (path === `/nodes/${ALBUM}/cover/candidate` && init?.method === 'POST') return ok({ nodeId: ALBUM, source: 'manual' }, 201)
      if (path === `/nodes/${ALBUM}/cover` && init?.method === 'POST') return ok({ nodeId: ALBUM, source: 'manual' }, 201)
      if (path === `/nodes/${ALBUM}/cover` && init?.method === 'DELETE') return { ok: true, status: 204, json: async () => null } as Response
      return { ok: false, status: 404, json: async () => ({}) } as Response
    }),
  )
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

async function render(element: ReactElement) {
  root = createRoot(container)
  await act(async () => root!.render(element))
  await settle()
}

const settle = () =>
  act(async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve()
  })

function requests(): { path: string; method: string; search: string; body: unknown }[] {
  return vi.mocked(fetch).mock.calls.map(([url, init]) => {
    const parsed = new URL(String(url))
    return { path: parsed.pathname.replace('/api/v1', ''), search: parsed.search, method: init?.method ?? 'GET', body: init?.body }
  })
}

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')
const button = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.getAttribute('aria-label') === name || b.textContent?.trim() === name)

async function click(element: HTMLElement | undefined | null) {
  expect(element).toBeTruthy()
  await act(async () => element!.click())
  await settle()
}

describe('CoverPicker', () => {
  it("lists both sources' candidates, each labelled, with thumbnails from this server", async () => {
    await render(<CoverPicker open onClose={() => undefined} nodeId={ALBUM} />)
    expect(dialog()?.textContent).toContain('For Rumours by Fleetwood Mac')

    const caaSection = document.querySelector('section[aria-label="The Cover Art Archive"]')!
    expect([...caaSection.querySelectorAll('li button')].map((b) => b.getAttribute('aria-label'))).toEqual([
      'Use the front from 1977 · US',
      'Use the back from 1977 · US',
    ])
    const deezerSection = document.querySelector('section[aria-label="Deezer"]')!
    expect(deezerSection.textContent).toContain('Rumours (Super Deluxe) · 58 tracks')

    // Every thumbnail is the server's proxy, never the source itself.
    const thumbs = [...document.querySelectorAll<HTMLImageElement>('[role="dialog"] img')].map((img) => img.getAttribute('src'))
    expect(thumbs).toHaveLength(3)
    for (const src of thumbs) expect(src).toMatch(/^http:\/\/[^/]+\/api\/v1\/cover-candidates\/(caa|deezer)%3A[^/]+\/thumb/)
  })

  it('stores a chosen candidate, closes, and shows the new cover without a reload', async () => {
    const onClose = vi.fn()
    await render(
      <>
        <CoverPicker open onClose={onClose} nodeId={ALBUM} />
        <CoverArt nodeId={TRACK} size="thumb" />
        <CoverArt nodeId={99} size="thumb" />
      </>,
    )
    const trackCover = () => container.querySelectorAll('img')[0].getAttribute('src')
    const otherCover = () => container.querySelectorAll('img')[1].getAttribute('src')
    expect(trackCover()).not.toContain('v=')

    await click(button(`Use the back from 1977 · US`))

    const choose = requests().find((r) => r.path === `/nodes/${ALBUM}/cover/candidate`)
    expect(choose?.method).toBe('POST')
    expect(JSON.parse(String(choose?.body))).toEqual({ candidate: `caa:${CD}:back` })
    expect(onClose).toHaveBeenCalled()
    // The album's track asks for its art again; a cover that didn't change doesn't.
    expect(trackCover()).toContain('v=1')
    expect(otherCover()).not.toContain('v=')
  })

  it('lists every image of every edition when asked', async () => {
    await render(<CoverPicker open onClose={() => undefined} nodeId={ALBUM} />)
    await click(button('show 3 more images'))
    expect(requests().some((r) => r.path === `/nodes/${ALBUM}/cover/candidates` && r.search.includes('all=1'))).toBe(true)
    expect(button('Use the booklet from 1977 · US')).toBeTruthy()
    expect(button('show 3 more images')).toBeUndefined()
  })

  it('says when a source has nothing for the album', async () => {
    caa = { source: 'caa', match: null, candidates: [], more: 0 }
    await render(<CoverPicker open onClose={() => undefined} nodeId={ALBUM} />)
    expect(dialog()?.textContent).toContain('Nothing on the Cover Art Archive matches Rumours.')
  })

  it('offers only the upload with online lookups off, and looks nothing up', async () => {
    picker = { ...picker, online: false }
    await render(<CoverPicker open onClose={() => undefined} nodeId={ALBUM} />)
    expect(dialog()?.textContent).toContain('Looking up metadata online is off')
    expect(document.querySelector('section[aria-label="The Cover Art Archive"]')).toBeNull()
    expect(document.querySelector('section[aria-label="Deezer"]')).toBeNull()
    expect(button('Drop an image here or choose a file')).toBeTruthy()
    expect(requests().map((r) => r.path)).toEqual([`/nodes/${ALBUM}/cover/picker`])
  })

  it('uploads a chosen file as the cover', async () => {
    const onClose = vi.fn()
    await render(<CoverPicker open onClose={onClose} nodeId={ALBUM} />)
    const input = document.querySelector<HTMLInputElement>('[data-testid="cover-upload-input"]')!
    const file = new File(['png bytes'], 'scan.png', { type: 'image/png' })
    Object.defineProperty(input, 'files', { value: [file] })
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
    await settle()

    const upload = requests().find((r) => r.path === `/nodes/${ALBUM}/cover` && r.method === 'POST')
    expect(upload?.body).toBe(file)
    const init = vi.mocked(fetch).mock.calls.find(([url, i]) => String(url).endsWith(`/nodes/${ALBUM}/cover`) && i?.method === 'POST')?.[1]
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('image/png')
    expect(onClose).toHaveBeenCalled()
  })

  it('takes a dropped image', async () => {
    await render(<CoverPicker open onClose={() => undefined} nodeId={ALBUM} />)
    const zone = button('Drop an image here or choose a file')!
    const file = new File(['jpeg'], 'cover.jpg', { type: 'image/jpeg' })
    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [file] } })
    await act(async () => zone.dispatchEvent(drop))
    await settle()
    expect(requests().find((r) => r.path === `/nodes/${ALBUM}/cover` && r.method === 'POST')?.body).toBe(file)
  })

  it("refuses a file that isn't an image before sending it", async () => {
    await render(<CoverPicker open onClose={() => undefined} nodeId={ALBUM} />)
    const input = document.querySelector<HTMLInputElement>('[data-testid="cover-upload-input"]')!
    Object.defineProperty(input, 'files', { value: [new File(['%PDF'], 'liner notes.pdf', { type: 'application/pdf' })] })
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
    await settle()
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("liner notes.pdf isn't an image.")
    expect(requests().some((r) => r.method === 'POST')).toBe(false)
  })

  it('puts a manual choice back to the automatic cover', async () => {
    picker = { ...picker, manual: true }
    const onClose = vi.fn()
    await render(<CoverPicker open onClose={onClose} nodeId={ALBUM} />)
    await click(button('Use the automatic cover'))
    expect(requests().some((r) => r.path === `/nodes/${ALBUM}/cover` && r.method === 'DELETE')).toBe(true)
    expect(onClose).toHaveBeenCalled()
  })

  it('offers no reset when the cover is already automatic', async () => {
    await render(<CoverPicker open onClose={() => undefined} nodeId={ALBUM} />)
    expect(button('Use the automatic cover')).toBeUndefined()
  })

  it('looks nothing up until it opens', async () => {
    await render(<CoverPicker open={false} onClose={() => undefined} nodeId={ALBUM} />)
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('ChangeCover', () => {
  it("opens the picker on the album's cover", async () => {
    await render(
      <ChangeCover nodeId={ALBUM} label="Change the album's cover">
        <span>art</span>
      </ChangeCover>,
    )
    expect(dialog()).toBeNull()
    await click(button("Change the album's cover"))
    expect(dialog()?.textContent).toContain('Change cover')
    expect(requests()[0].path).toBe(`/nodes/${ALBUM}/cover/picker`)
  })
})
