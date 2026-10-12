// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GraphDataContext, type GraphData } from '../canvas/graphContext'
import type { GraphNode } from '../canvas/useGraphData'
import type { QueueEntry, usePlayback } from '../playback/usePlayback'
import { UpNextList } from './UpNextList'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Playback = ReturnType<typeof usePlayback>

const roots: Root[] = []

beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })),
  )
})

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()))
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const QUEUE: QueueEntry[] = [
  { recordingNodeId: 11, title: 'Low Tide', durationMs: 220_000 },
  { recordingNodeId: 12, title: 'Harbour Wall', durationMs: 303_000 },
  { recordingNodeId: 13, title: 'Night Ferry', durationMs: 110_000 },
]

const GRAPH = {
  nodes: [],
  edges: [],
  loading: false,
  refetch: async () => undefined,
  byId: new Map([11, 12, 13].map((id) => [id, { id, subtitle: 'Harbour Lights' } as GraphNode])),
} as GraphData

function fakePlayback(patch: Partial<Playback> = {}): Playback {
  return {
    currentTitle: 'Tidewater part 1',
    upNext: QUEUE,
    queueBusy: false,
    next: vi.fn(async () => undefined),
    moveUpNext: vi.fn(async () => undefined),
    removeUpNext: vi.fn(async () => undefined),
    clearUpNext: vi.fn(async () => undefined),
    ...patch,
  } as unknown as Playback
}

function render(playback: Playback, from: string | null = 'Tidewater', onShuffleLibrary = vi.fn()) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() =>
    root.render(
      createElement(GraphDataContext.Provider, { value: GRAPH }, createElement(UpNextList, { playback, from, onShuffleLibrary })),
    ),
  )
  const titles = () => [...container.querySelectorAll('ol > li span[title]')].map((el) => el.textContent)
  const button = (name: string) =>
    [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => (b.getAttribute('aria-label') ?? b.textContent?.trim()) === name,
    )!
  return { container, titles, button }
}

describe('UpNextList', () => {
  it('says where the queue is playing from, with clear', () => {
    const playback = fakePlayback()
    const { container, button } = render(playback)
    expect(container.textContent).toContain('Playing from Tidewater')
    act(() => button('clear').click())
    expect(playback.clearUpNext).toHaveBeenCalledOnce()
  })

  it('counts the tracks when the queue came from nowhere in particular', () => {
    const { container } = render(fakePlayback(), null)
    expect(container.textContent).toContain('3 tracks up next')
  })

  it('draws 58px rows of the cover, the title over the artist, and the duration', () => {
    const { container, titles } = render(fakePlayback())
    expect(titles()).toEqual(['Low Tide', 'Harbour Wall', 'Night Ferry'])
    const row = container.querySelector<HTMLElement>('ol > li')!
    expect(row.style.height).toBe('58px')
    expect(row.textContent).toContain('Harbour Lights')
    expect(row.textContent).toContain('3:40')
  })

  it('plays a row by stepping forward to it, as the desktop does', async () => {
    const playback = fakePlayback()
    const { container } = render(playback)
    const third = container.querySelectorAll('ol > li span[title]')[2].closest('button')!
    await act(async () => third.click())
    // Each step waits on the last.
    await vi.waitFor(() => expect(playback.next).toHaveBeenCalledTimes(3))
  })

  it('moves and removes rows from buttons a keyboard or a screen reader can reach, showing the edit at once', () => {
    const playback = fakePlayback()
    const { titles, button } = render(playback)
    expect(button('Move Low Tide up').disabled).toBe(true)
    expect(button('Move Night Ferry down').disabled).toBe(true)

    act(() => button('Move Low Tide down').click())
    expect(playback.moveUpNext).toHaveBeenCalledWith(0, 1)
    expect(titles()).toEqual(['Harbour Wall', 'Low Tide', 'Night Ferry'])

    act(() => button('Remove Night Ferry from up next').click())
    expect(playback.removeUpNext).toHaveBeenCalledWith(2)
    expect(titles()).toEqual(['Harbour Wall', 'Low Tide'])
  })

  it('keeps a moved row its own element, so the focus goes with it', () => {
    const { container, button } = render(fakePlayback())
    const row = container.querySelector('ol > li')!
    act(() => button('Move Low Tide down').click())
    expect(container.querySelectorAll('ol > li')[1]).toBe(row)
  })

  it('keeps the swiped-open remove out of reach until a row is swiped', () => {
    const { container } = render(fakePlayback())
    const action = container.querySelector<HTMLButtonElement>('[data-swipe-action]')!
    expect(action.getAttribute('aria-hidden')).toBe('true')
    expect(action.tabIndex).toBe(-1)
  })

  it('says nothing is after this track, with a way to keep going', () => {
    const onShuffleLibrary = vi.fn()
    const { container, button } = render(fakePlayback({ upNext: [] }), 'Tidewater', onShuffleLibrary)
    expect(container.textContent).toContain('Nothing after this track')
    expect(container.textContent).not.toContain('clear')
    act(() => button('Shuffle library').click())
    expect(onShuffleLibrary).toHaveBeenCalledOnce()
  })

  it('says nothing is playing with nothing loaded', () => {
    const { container } = render(fakePlayback({ currentTitle: null, upNext: [] }))
    expect(container.textContent).toContain('Nothing playing')
  })
})
