// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NodeDetail } from '../panels/useNodeDetail'
import type { usePlayback } from '../playback/usePlayback'
import { NowPlayingScreen } from './NowPlayingScreen'
import type { PlayingTrack } from './usePlayingTrack'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Playback = ReturnType<typeof usePlayback>

const roots: Root[] = []

beforeEach(() => {
  // The more menu's popover watches its anchor.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })),
  )
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const body = String(url).endsWith('/lyrics')
        ? { found: true, instrumental: false, plainLyrics: 'out past the harbour wall\nthe ferry lights', syncedLyrics: null }
        : []
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }),
  )
  HTMLElement.prototype.setPointerCapture = vi.fn()
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(844)
})

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()))
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  document.body.innerHTML = ''
})

const TRACK: PlayingTrack = {
  nodeId: 7,
  detail: { id: 7, is_favourite: false, edges: [] } as unknown as NodeDetail,
  artist: 'Harbour Lights',
  artistId: 1,
  album: 'Tidewater',
  albumId: 2,
}

function fakePlayback(): Playback {
  return {
    currentTitle: 'Tidewater part 1',
    status: {
      playing: true,
      positionMs: 30_000,
      currentRecordingNodeId: 7,
      currentFileId: 70,
      currentDurationMs: 120_000,
      streaming: false,
      volume: 1,
    },
    shuffled: false,
    queueBusy: false,
    problem: null,
    seek: vi.fn(),
    toggleShuffle: vi.fn(),
    previous: vi.fn(),
    next: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    resolveProblem: vi.fn(),
  } as unknown as Playback
}

function render(props: { from?: string | null; open?: boolean } = {}) {
  const handlers = {
    onClose: vi.fn(),
    onClosed: vi.fn(),
    onShowOnMap: vi.fn(),
    onOpenNode: vi.fn(),
    onOpenUpNext: vi.fn(),
    onCycleRepeat: vi.fn(),
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  const draw = (open: boolean) =>
    act(() =>
      root.render(
        createElement(NowPlayingScreen, {
          open,
          playback: fakePlayback(),
          track: TRACK,
          from: props.from === undefined ? 'Tidewater' : props.from,
          platform: 'ios',
          repeatMode: 'off',
          ...handlers,
        }),
      ),
    )
  draw(props.open ?? true)
  const screen = () => container.querySelector<HTMLElement>('section[aria-label="Now playing"]')!
  const button = (name: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => (b.getAttribute('aria-label') ?? b.textContent?.trim()) === name,
    )!
  return { container, screen, button, handlers, draw }
}

function pointer(el: Element, type: string, clientX: number, clientY: number, timeStamp: number) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY, button: 0 })
  Object.defineProperty(event, 'pointerId', { value: 1 })
  Object.defineProperty(event, 'pointerType', { value: 'touch' })
  Object.defineProperty(event, 'timeStamp', { value: timeStamp })
  act(() => el.dispatchEvent(event))
}

describe('NowPlayingScreen', () => {
  it('says where the queue is playing from in its header, or just that it is playing', () => {
    expect(render().screen().querySelector('header')!.textContent!.trim()).toBe('playing fromTidewater')
    expect(render({ from: null }).screen().querySelector('header')!.textContent!.trim()).toBe('now playing')
  })

  it('shows the title, the artist and the elapsed, quality and remaining readouts', () => {
    const { screen } = render()
    expect(screen().querySelector('h2')!.textContent).toBe('Tidewater part 1')
    expect(screen().textContent).toContain('Harbour Lights')
    const readouts = [...screen().querySelector('[role="slider"]')!.nextElementSibling!.children].map((el) => el.textContent)
    expect(readouts).toHaveLength(3)
    expect(readouts[0]).toBe('0:30')
    expect(readouts[2]).toBe('−1:30')
  })

  it('closes from the collapse chevron and from Escape', () => {
    const { screen, button, handlers } = render()
    act(() => button('Close now playing').click())
    act(() => screen().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(handlers.onClose).toHaveBeenCalledTimes(2)
  })

  it('swaps the lyrics in for the cover, and back on a second tap', async () => {
    const { screen, button } = render()
    expect(screen().querySelector('img')).not.toBeNull()
    await act(async () => button('lyrics').click())
    await vi.waitFor(() => expect(screen().textContent).toContain('out past the harbour wall'))
    expect(button('lyrics').getAttribute('aria-pressed')).toBe('true')
    expect(screen().querySelector('img')).toBeNull()
    act(() => button('lyrics').click())
    expect(screen().textContent).not.toContain('out past the harbour wall')
    expect(screen().querySelector('img')).not.toBeNull()
  })

  it('shows the track on the map, and opens up next', () => {
    const { button, handlers } = render()
    act(() => button('show on map').click())
    expect(handlers.onShowOnMap).toHaveBeenCalledWith(7)
    act(() => button('up next').click())
    expect(handlers.onOpenUpNext).toHaveBeenCalledOnce()
  })

  it('opens the album or the artist from the more menu', () => {
    const { button, handlers } = render()
    act(() => button('More').click())
    const items = [...document.querySelectorAll('[role="dialog"][aria-label="More"] button')].map((b) => b.textContent)
    expect(items).toEqual(['add to playlist', 'go to album', 'go to artist'])
    act(() => button('go to album').click())
    expect(handlers.onOpenNode).toHaveBeenCalledWith(2)
    act(() => button('More').click())
    act(() => button('go to artist').click())
    expect(handlers.onOpenNode).toHaveBeenLastCalledWith(1)
  })

  it('swaps the more menu for the playlist picker, at 44px', async () => {
    const { button } = render()
    act(() => button('More').click())
    await act(async () => button('add to playlist').click())
    const field = document.querySelector('[role="dialog"][aria-label="Add to playlist"] input[aria-label="New playlist name"]')!
    expect(field.parentElement!.className).toContain('h-[44px]')
    expect(button('Create playlist and add').style.height).toBe('44px')
  })

  it('closes on a swipe down, but not on a swipe sideways', () => {
    const { screen, handlers } = render()
    const title = screen().querySelector('h2')!
    pointer(title, 'pointerdown', 200, 300, 1000)
    pointer(title, 'pointermove', 260, 304, 1010)
    pointer(title, 'pointermove', 320, 306, 1020)
    pointer(screen(), 'pointerup', 320, 306, 1030)
    expect(handlers.onClose).not.toHaveBeenCalled()

    pointer(title, 'pointerdown', 200, 300, 2000)
    pointer(title, 'pointermove', 200, 340, 2016)
    pointer(screen(), 'pointermove', 200, 420, 2032)
    pointer(screen(), 'pointerup', 200, 420, 2040)
    expect(handlers.onClose).toHaveBeenCalledOnce()
  })

  it('springs back from a short slow pull', () => {
    const { screen, handlers } = render()
    const title = screen().querySelector('h2')!
    pointer(title, 'pointerdown', 200, 300, 1000)
    pointer(title, 'pointermove', 200, 320, 1100)
    pointer(screen(), 'pointermove', 200, 340, 1300)
    pointer(screen(), 'pointerup', 200, 340, 1500)
    expect(handlers.onClose).not.toHaveBeenCalled()
    expect(screen().style.transform).toBe('')
  })

  it('slides away once closed, then says it has', () => {
    vi.useFakeTimers()
    const { screen, draw, handlers } = render()
    draw(false)
    expect(screen().style.transform).toBe('translate3d(0, 100%, 0)')
    expect(handlers.onClosed).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(400))
    expect(handlers.onClosed).toHaveBeenCalledOnce()
  })

  it('makes every chip and button a 44px target', () => {
    const { screen } = render()
    for (const chip of ['lyrics', 'show on map', 'up next']) {
      const el = [...screen().querySelectorAll('button')].find((b) => b.textContent?.trim() === chip)!
      expect(el.className).toContain('touch-target')
    }
    for (const name of ['Close now playing', 'More', 'Add to favourites', 'Shuffle off', 'Repeat off']) {
      const el = screen().querySelector<HTMLElement>(`button[aria-label="${name}"]`)!
      expect(parseFloat(el.style.width || '44') >= 44 || el.className.includes('size-[44px]')).toBe(true)
    }
  })
})
