// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Player } from './Player'
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

function renderPlayer(problem: PlaybackProblem | null, onResolveProblem = () => undefined) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const noop = () => undefined
  act(() => {
    createRoot(container).render(
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
