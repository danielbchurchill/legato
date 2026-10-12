// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NodeDetail } from '../panels/useNodeDetail'
import type { usePlayback } from '../playback/usePlayback'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The track's details, as the server would send them: performed by Harbour
// Lights, on Tidewater. Null until a test says it has arrived.
const detail = vi.hoisted(() => ({ node: null as NodeDetail | null, asked: [] as (number | null)[] }))

vi.mock('../panels/useNodeDetail', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../panels/useNodeDetail')>()
  return {
    ...actual,
    useNodeDetail: (id: number | null) => {
      detail.asked.push(id)
      return { node: detail.node, reload: () => undefined }
    },
  }
})

import { MiniPlayer } from './MiniPlayer'

type Playback = ReturnType<typeof usePlayback>

const roots: Root[] = []

beforeEach(() => {
  detail.node = null
  detail.asked = []
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

function fakePlayback(patch: Partial<Playback> = {}, status: Partial<Playback['status']> = {}): Playback {
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
      ...status,
    },
    queueBusy: false,
    problem: null,
    pause: vi.fn(),
    resume: vi.fn(),
    next: vi.fn(),
    resolveProblem: vi.fn(),
    ...patch,
  } as unknown as Playback
}

function render(playback: Playback, props: { compact?: boolean; canShuffle?: boolean; onShuffleLibrary?: () => void } = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() =>
    root.render(
      createElement(MiniPlayer, {
        playback,
        artist: 'Harbour Lights',
        compact: props.compact ?? false,
        canShuffle: props.canShuffle ?? true,
        onShuffleLibrary: props.onShuffleLibrary ?? (() => undefined),
      }),
    ),
  )
  const button = (name: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)
  return {
    container,
    button,
    rerender: (next: Playback) =>
      act(() =>
        root.render(
          createElement(MiniPlayer, {
            playback: next,
            artist: 'Harbour Lights',
            compact: props.compact ?? false,
            canShuffle: true,
            onShuffleLibrary: () => undefined,
          }),
        ),
      ),
  }
}

const TIDEWATER = {
  id: 7,
  edges: [
    { direction: 'out', type: 'performed_by', other_id: 1, other_title: 'Harbour Lights' },
    { direction: 'out', type: 'appears_on', other_id: 2, other_title: 'Tidewater' },
  ],
} as unknown as NodeDetail

describe('MiniPlayer', () => {
  it("says nothing is playing, with the idle pill's one way in", () => {
    const onShuffleLibrary = vi.fn()
    const { container } = render(fakePlayback({ currentTitle: null }, { playing: false, currentRecordingNodeId: null }), {
      onShuffleLibrary,
    })
    expect(container.textContent).toContain('Nothing playing')
    const shuffle = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Shuffle library'))!
    act(() => shuffle.click())
    expect(onShuffleLibrary).toHaveBeenCalledOnce()
    // Nothing to look up while nothing plays.
    expect(detail.asked.every((id) => id == null)).toBe(true)
  })

  it("can't shuffle when there's nothing to shuffle", () => {
    const { container } = render(fakePlayback({ currentTitle: null }, { currentRecordingNodeId: null }), { canShuffle: false })
    const shuffle = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Shuffle library'))!
    expect(shuffle.disabled).toBe(true)
  })

  it("shows the title over the artist from the map until the track's details arrive, then artist · album", () => {
    const playback = fakePlayback()
    const { container, rerender } = render(playback)
    expect(container.textContent).toContain('Tidewater part 1')
    expect(container.textContent).toContain('Harbour Lights')
    detail.node = TIDEWATER
    rerender(fakePlayback())
    expect(container.textContent).toContain('Harbour Lights · Tidewater')
  })

  it('pauses, plays and skips from its own buttons', () => {
    const playing = fakePlayback()
    const { button } = render(playing)
    act(() => button('Pause')!.click())
    expect(playing.pause).toHaveBeenCalledOnce()
    act(() => button('Next track')!.click())
    expect(playing.next).toHaveBeenCalledOnce()

    const paused = fakePlayback({}, { playing: false })
    const second = render(paused)
    act(() => second.button('Play')!.click())
    expect(paused.resume).toHaveBeenCalledOnce()
  })

  it('shows where the track is, stepping rather than easing', () => {
    const { container } = render(fakePlayback())
    const bar = container.querySelector<HTMLElement>('[role="progressbar"]')!
    expect(bar.getAttribute('aria-valuetext')).toBe('0:30 of 2:00')
    const fill = bar.firstElementChild as HTMLElement
    expect(fill.style.width).toBe('25%')
    expect(fill.className).not.toContain('transition')
  })

  it('compresses at large to the title over the artist and pause alone', () => {
    detail.node = TIDEWATER
    const { container, button } = render(fakePlayback(), { compact: true })
    expect(container.textContent).toContain('Harbour Lights')
    expect(container.textContent).not.toContain('Tidewater ·')
    expect(container.textContent).not.toContain('· Tidewater')
    expect(button('Pause')).not.toBeNull()
    expect(button('Next track')).toBeNull()
    expect(container.querySelector('[role="progressbar"]')).toBeNull()
  })

  it('turns play into the fix for a track that would not start', () => {
    const playback = fakePlayback(
      { problem: { headline: "Can't find this file", detail: 'The drive is unplugged', action: 'skip' } as Playback['problem'] },
      { playing: false },
    )
    const { container, button } = render(playback)
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Can't find this file")
    act(() => button('Skip track')!.click())
    expect(playback.resolveProblem).toHaveBeenCalledOnce()
  })

  it('makes every control a 44px target', () => {
    const { container } = render(fakePlayback())
    for (const name of ['Pause', 'Next track']) {
      const el = container.querySelector<HTMLElement>(`button[aria-label="${name}"]`)!
      expect(el.style.width).toBe('44px')
      expect(el.style.height).toBe('44px')
    }
  })
})
