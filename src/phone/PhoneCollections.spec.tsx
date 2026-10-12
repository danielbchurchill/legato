// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GraphDataContext, type GraphData } from '../canvas/graphContext'
import type { usePlayback } from '../playback/usePlayback'
import type { Favourite, PlaylistSummary } from '../panels/collectionsData'
import { PhoneCollections } from './PhoneCollections'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* The phone's collections tab (#389, step 3) against a fake server. */

let playlists: PlaylistSummary[]
let favourites: Favourite[]
let created: string[]
let root: Root | null = null

const GRAPH: GraphData = { nodes: [], edges: [], loading: false, refetch: async () => undefined, byId: new Map() }

beforeEach(() => {
  history.replaceState(null, '')
  playlists = [
    { id: 1, name: 'Sunday mornings', track_count: 6 },
    { id: 2, name: 'Road trip', track_count: 1 },
  ]
  favourites = [
    { id: 10, type: 'artist', title: 'Bob Dylan' },
    { id: 11, type: 'release', title: 'Highway 61 Revisited' },
  ]
  created = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const route = new URL(input).pathname.replace(/^.*\/api\/v1/, '')
      if (route === '/playlists' && init?.method === 'POST') {
        const { name } = JSON.parse(String(init.body)) as { name: string }
        created.push(name)
        const playlist = { id: 99, name, track_count: 0 }
        playlists = [...playlists, playlist]
        return Response.json(playlist)
      }
      if (route === '/playlists') return Response.json(playlists)
      if (route === '/favourites') return Response.json(favourites)
      if (/^\/playlists\/\d+\/tracks$/.test(route)) return Response.json([])
      // A playlist that wasn't imported has no import report.
      return Response.json(null)
    }),
  )
  vi.stubGlobal(
    'WebSocket',
    class {
      onmessage = null
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

async function settle() {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

async function render() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const onOpenNode = vi.fn()
  const playback = { playPlaylist: vi.fn(), queueBusy: false, status: { currentRecordingNodeId: null, playing: false } }
  await act(async () => {
    root = createRoot(container)
    root.render(
      createElement(
        GraphDataContext.Provider,
        { value: GRAPH },
        createElement(PhoneCollections, { onOpenNode, playback: playback as unknown as ReturnType<typeof usePlayback> }),
      ),
    )
  })
  await settle()
  return { container, onOpenNode }
}

const tiles = (container: HTMLElement) => [...container.querySelectorAll('[aria-label="Collections"] > li')].map((li) => li.textContent)
const button = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes(text))!

/* jsdom fires popstate for history.back() on a later task, as a browser does. */
async function back() {
  await act(async () => {
    const popped = new Promise<void>((resolve) => window.addEventListener('popstate', () => resolve(), { once: true }))
    history.back()
    await popped
  })
  await settle()
}

describe('the phone collections tab', () => {
  it('counts favourites as one collection, first, then the playlists', async () => {
    const { container } = await render()
    expect(container.textContent).toContain('3 collections')
    expect(tiles(container)).toEqual(['Favourites2 favourites', 'Sunday mornings6 tracks', 'Road trip1 track'])
  })

  it('leaves favourites out when there are none', async () => {
    favourites = []
    const { container } = await render()
    expect(container.textContent).toContain('2 collections')
    expect(tiles(container)).toEqual(['Sunday mornings6 tracks', 'Road trip1 track'])
  })

  it('opens Favourites inside the tab, which the system back leaves', async () => {
    const { container, onOpenNode } = await render()
    await act(async () => button(container, 'Favourites').click())
    await settle()
    const list = container.querySelector('ul[aria-label="Favourites"]')!
    expect(list.textContent).toContain('Bob Dylan')
    expect(list.textContent).toContain('album')
    await act(async () => button(list as HTMLElement, 'Highway 61 Revisited').click())
    expect(onOpenNode).toHaveBeenCalledWith(11)

    await back()
    expect(container.querySelector('ul[aria-label="Favourites"]')).toBeNull()
    expect(container.textContent).toContain('3 collections')
  })

  it("opens a playlist on the desktop's page, whose back leaves it", async () => {
    const { container } = await render()
    await act(async () => button(container, 'Road trip').click())
    await settle()
    expect(history.state).toMatchObject({ legatoSheetView: { kind: 'playlist', playlistId: 2 } })
    const backRow = button(container, 'Collections')
    const popped = new Promise<void>((resolve) => window.addEventListener('popstate', () => resolve(), { once: true }))
    await act(async () => backRow.click())
    await act(async () => popped)
    await settle()
    expect(container.textContent).toContain('3 collections')
  })

  it('names a new playlist from "new" and opens it', async () => {
    const { container } = await render()
    await act(async () => button(container, 'new').click())
    await act(async () => button(document.body, 'New playlist').click())
    const field = container.querySelector<HTMLInputElement>('input[aria-label="New playlist name"]')!
    expect(field).not.toBeNull()
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setValue.call(field, 'Late night')
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(button(container, 'Create').className).toContain('touch-target')
    await act(async () => button(container, 'Create').click())
    await settle()
    expect(created).toEqual(['Late night'])
    expect(history.state).toMatchObject({ legatoSheetView: { kind: 'playlist', playlistId: 99 } })
  })

  it("says there's nothing yet, with the desktop's two ways to start, at a phone's size", async () => {
    playlists = []
    favourites = []
    const { container } = await render()
    expect(container.textContent).toContain('No playlists yet')
    expect(container.querySelector('[aria-label="Collections"]')).toBeNull()
    for (const name of ['New playlist', 'Import .m3u']) {
      expect(button(container, name).className).toContain('h-[36px]')
      expect(button(container, name).className).toContain('touch-target')
    }
    await act(async () => button(container, 'Import .m3u').click())
    await settle()
    expect(history.state).toMatchObject({ legatoSheetView: { kind: 'import' } })
  })
})
