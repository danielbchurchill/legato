// @vitest-environment jsdom
//
// #447 and #448: add to playlist from any desktop track row, and a whole
// album at once.
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AddToPlaylistButton, RowAddToPlaylist } from './AddToPlaylistButton'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let container: HTMLDivElement
let addAnswers: 'ok' | 'fail' = 'ok'

beforeEach(() => {
  addAnswers = 'ok'
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
      if (path === '/playlists' && init?.method === 'POST')
        return { ok: true, status: 200, json: async () => ({ id: 9, name: 'Night bus', track_count: 0 }) } as Response
      if (path === '/playlists')
        return { ok: true, status: 200, json: async () => [{ id: 7, name: 'Road trip', track_count: 3 }] } as Response
      if (path === '/nodes/20/tracklist')
        return {
          ok: true,
          status: 200,
          json: async () => [31, 32, 33, 34, 35, 36, 37, 38, 39].map((id) => ({ id, title: `Track ${id}` })),
        } as Response
      if (path.endsWith('/tracks') && init?.method === 'POST')
        return addAnswers === 'ok'
          ? ({ ok: true, status: 200, json: async () => ({}) } as Response)
          : ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) } as Response)
      return { ok: true, status: 200, json: async () => ({}) } as Response
    }),
  )
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  vi.unstubAllGlobals()
  vi.useRealTimers()
  document.body.innerHTML = ''
})

async function render(element: ReactElement) {
  root = createRoot(container)
  await act(async () => root!.render(element))
}

// Lets the fake server's answers land: microtasks only, so it works under
// fake timers too.
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}
const settle = () => act(flush)

const popup = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Add to playlist"]')

function posts() {
  return vi
    .mocked(fetch)
    .mock.calls.filter(([url, init]) => String(url).endsWith('/tracks') && init?.method === 'POST')
    .map(([url, init]) => ({ url: new URL(String(url)).pathname.replace('/api/v1', ''), body: JSON.parse(String(init?.body)) }))
}

async function pick(name: string) {
  await act(async () => {
    ;[...popup()!.querySelectorAll('button')].find((b) => b.textContent?.startsWith(name))!.click()
    await flush()
  })
}

describe('a track row on the desktop', () => {
  it('keeps its duration until hover or focus shows add to playlist in the same place', async () => {
    await render(
      <div className="group">
        <RowAddToPlaylist nodeId={5}>
          <span data-testid="duration">3:45</span>
        </RowAddToPlaylist>
      </div>,
    )
    const [duration, slot] = container.querySelectorAll('[class*="grid-area"]')
    expect(duration.querySelector('[data-testid="duration"]')).not.toBeNull()
    expect(slot.querySelector('button[aria-label="Add to playlist"]')).not.toBeNull()
    // Both in one grid cell, so swapping them moves nothing.
    expect(duration.className).toContain('[grid-area:1/1]')
    expect(slot.className).toContain('[grid-area:1/1]')
    // At rest the button is hidden and the duration shows; the row's hover
    // or focus turns them around.
    expect(slot.className.split(' ')).toContain('invisible')
    expect(slot.className).toContain('group-hover:visible')
    expect(slot.className).toContain('group-focus-within:visible')
    expect(duration.className).toContain('group-hover:invisible')
    expect(duration.className).toContain('group-focus-within:invisible')
  })

  it('opens the picker without the click reaching the row, and stays shown while it is open', async () => {
    const onRowClick = vi.fn()
    await render(
      <div className="group" onClick={onRowClick}>
        <RowAddToPlaylist nodeId={5}>3:45</RowAddToPlaylist>
      </div>,
    )
    const add = container.querySelector<HTMLButtonElement>('button[aria-label="Add to playlist"]')!
    await act(async () => add.click())
    await settle()
    expect(onRowClick).not.toHaveBeenCalled()
    expect(popup()).not.toBeNull()
    const slot = container.querySelectorAll('[class*="grid-area"]')[1]
    expect(slot.className.split(' ')).not.toContain('invisible')

    // A click inside the picker, portaled out of the row, doesn't reach it either.
    await pick('Road trip')
    expect(onRowClick).not.toHaveBeenCalled()
    expect(posts()).toEqual([{ url: '/playlists/7/tracks', body: { nodeId: 5 } }])
    expect(popup()!.textContent).toContain('added')
    expect(document.querySelector('[role="status"]')!.textContent).toBe('Added to Road trip')
  })

  it("keeps the picker's keys away from what's around the row", async () => {
    const onKeyDown = vi.fn()
    await render(
      <div className="group" onKeyDown={onKeyDown}>
        <RowAddToPlaylist nodeId={5}>3:45</RowAddToPlaylist>
      </div>,
    )
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Add to playlist"]')!.click())
    await settle()
    const field = popup()!.querySelector('input')!
    await act(async () => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(onKeyDown).not.toHaveBeenCalled()
  })

  it('says so when the add fails, and stays open', async () => {
    addAnswers = 'fail'
    await render(<AddToPlaylistButton nodeId={5} />)
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Add to playlist"]')!.click())
    await settle()
    await pick('Road trip')
    expect(popup()!.textContent).toContain('not added')
    expect(document.querySelector('[role="status"]')!.textContent).toBe("Couldn't add to Road trip")
  })
})

it('gives the focus to the popup, not the new playlist field, as it opens', async () => {
  await render(<AddToPlaylistButton nodeId={5} />)
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Add to playlist"]')!.click())
  expect(document.activeElement).toBe(popup())
  await settle()
  expect(document.activeElement).toBe(popup())
  expect(popup()!.querySelector('input')).not.toBeNull()
})

describe('an album', () => {
  it("adds every track in the album's order in one request, and says how many went in", async () => {
    await render(<AddToPlaylistButton albumId={20} />)
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Add album to playlist"]')!.click())
    await settle()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await pick('Road trip')
    expect(posts()).toEqual([{ url: '/playlists/7/tracks', body: { nodeIds: [31, 32, 33, 34, 35, 36, 37, 38, 39] } }])
    expect(popup()!.textContent).toContain('added 9 tracks')
    expect(document.querySelector('[role="status"]')!.textContent).toBe('Added 9 tracks to Road trip')
    // It stays long enough to read, then closes.
    act(() => vi.advanceTimersByTime(600))
    expect(popup()).not.toBeNull()
    act(() => vi.advanceTimersByTime(700))
    expect(popup()).toBeNull()
  })

  it('makes a new playlist and adds the album to it', async () => {
    await render(<AddToPlaylistButton albumId={20} />)
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Add album to playlist"]')!.click())
    await settle()
    const field = popup()!.querySelector('input')!
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setValue.call(field, 'Night bus')
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      popup()!.querySelector('form')!.requestSubmit()
      await flush()
    })
    expect(posts()).toEqual([{ url: '/playlists/9/tracks', body: { nodeIds: [31, 32, 33, 34, 35, 36, 37, 38, 39] } }])
    expect(popup()!.textContent).toContain('Night bus')
    expect(popup()!.textContent).toContain('added 9 tracks')
  })
})
