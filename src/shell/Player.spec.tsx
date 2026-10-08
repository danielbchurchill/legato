// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Player } from './Player'
import { ShellLayoutContext, computeShellLayout, type ShellLayout } from './layout'
import type { PlaybackProblem } from '../playback/playbackError'

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ json: async () => ({ peaks: [] }) }) as unknown as Response),
  )
  // jsdom has no matchMedia; the volume Popover asks it about reduced motion.
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

function renderPlayer(problem: PlaybackProblem | null, onResolveProblem = () => undefined, layout?: ShellLayout) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const noop = () => undefined
  act(() => {
    createRoot(container).render(
      createElement(
        ShellLayoutContext.Provider,
        { value: layout ?? computeShellLayout(1440, 1024, { leftOpen: false, rightOpen: false }) },
        createElement(Player, {
          title: 'Song',
          artist: 'Someone',
          queueOpen: false,
          onToggleQueue: noop,
          status: {
            playing: false,
            positionMs: 0,
            currentRecordingNodeId: null,
            currentFileId: null,
            currentDurationMs: null,
            volume: 1,
          },
          shuffled: false,
          queueBusy: false,
          repeatMode: 'off',
          problem,
          onResolveProblem,
          onPause: noop,
          onResume: noop,
          onSeek: noop,
          onSetVolume: noop,
          onNext: noop,
          onPrevious: noop,
          onToggleShuffle: noop,
          onCycleRepeat: noop,
        }),
      ),
    )
  })
  return container
}

describe('Player playback problem (#184)', () => {
  it('replaces the waveform with the message and its one action', () => {
    const onResolveProblem = vi.fn()
    const container = renderPlayer(
      {
        headline: 'The library drive looks disconnected on this machine',
        detail: 'Nothing is at /mnt/music, where “Song” should be. Reconnect or mount the drive, then try again.',
        action: 'retry',
      },
      onResolveProblem,
    )

    const alert = container.querySelector('[role="alert"]')!
    expect(alert.textContent).toContain('The library drive looks disconnected on this machine')
    expect(alert.textContent).toContain('/mnt/music')
    expect(container.querySelector('[aria-label="Seek"]')).toBeNull()
    // Paused-looking, not playing.
    expect(container.querySelector('[aria-label="Play"]')).not.toBeNull()

    const action = [...alert.querySelectorAll('button')].find((b) => b.textContent === 'Try again')!
    act(() => action.click())
    expect(onResolveProblem).toHaveBeenCalledOnce()
  })

  it('labels the action Skip track for a file that is simply gone', () => {
    const container = renderPlayer({ headline: "Can't open “Song”", detail: 'missing', action: 'skip' })
    expect(container.querySelector('[role="alert"] button')?.textContent).toBe('Skip track')
  })

  it('shows the waveform scrubber when nothing is wrong', () => {
    const container = renderPlayer(null)
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.querySelector('[aria-label="Seek"]')).not.toBeNull()
  })
})

// #293: what the player draws follows the parts layout.ts picks for its width.
describe('Player in a narrow bar', () => {
  const buttons = (container: HTMLElement) => [...container.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))

  it('keeps the cover, the whole transport and the scrubber at the narrowest desktop window', () => {
    const container = renderPlayer(null, undefined, computeShellLayout(1100, 700, { leftOpen: true, rightOpen: true }))
    expect(buttons(container)).toEqual(['Shuffle off', 'Previous track', 'Play', 'Next track', 'Repeat off'])
    expect(container.querySelector('[aria-label="Seek"]')?.children).toHaveLength(24)
    // The title column has given way on screen, but still names the track.
    expect(container.querySelector('.sr-only')?.textContent).toBe('SongSomeone')
  })
})
