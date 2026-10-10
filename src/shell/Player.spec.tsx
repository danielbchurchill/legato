// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IdlePlayer, Player } from './Player'
import { ShellLayoutContext, computeShellLayout, type ShellLayout } from './layout'
import * as geometry from './playerGeometry'
import * as controls from './controlGeometry'
import type { PlaybackProblem } from '../playback/playbackError'

const roots: Root[] = []

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
  // Nor ResizeObserver, which a tooltip places itself with.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
})

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()))
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

function renderPlayer(problem: PlaybackProblem | null, onResolveProblem = () => undefined, layout?: ShellLayout, streaming = false) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const noop = () => undefined
  const root = createRoot(container)
  roots.push(root)
  act(() => {
    root.render(
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
            streaming,
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

describe('Player streaming label (#185)', () => {
  it('says quietly that a track is streaming from the server', () => {
    const container = renderPlayer(null, undefined, undefined, true)
    // The innermost match: the tooltip's wrapper holds the same text.
    const label = [...container.querySelectorAll('span')].findLast((s) => s.textContent === ' · streaming')
    expect(label).toBeDefined()
    expect(label!.className).toContain('--color-ink-3')
  })

  it('says nothing for a track playing from this computer', () => {
    const container = renderPlayer(null)
    expect(container.textContent).not.toContain('streaming')
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

  it('comes down to previous, play/pause and next, and still says why a track failed', () => {
    const layout = computeShellLayout(900, 700, { leftOpen: true, rightOpen: true })
    expect(buttons(renderPlayer(null, undefined, layout))).toEqual(['Previous track', 'Play', 'Next track'])
    document.body.innerHTML = ''

    const container = renderPlayer({ headline: "Can't open “Song”", detail: 'missing', action: 'skip' }, undefined, layout)
    expect(container.querySelector('[role="alert"] button')?.textContent).toBe('Skip track')
  })
})

// #293: layout.ts picks what fits by adding up playerGeometry.ts's sizes, so
// the player has to be drawn at exactly those sizes. A size typed into
// Player.tsx instead would move the drawing and leave every threshold behind.
describe('Player geometry', () => {
  const px = (n: number) => `${n}px`

  it('draws every button at the size layout.ts adds up', () => {
    const container = renderPlayer(null)
    const width = (label: string) => container.querySelector<HTMLElement>(`[aria-label="${label}"]`)!.style.width
    expect(width('Shuffle off')).toBe(px(geometry.PLAYER_SHUFFLE_SIZE))
    expect(width('Previous track')).toBe(px(geometry.PLAYER_SKIP_SIZE))
    expect(width('Play')).toBe(px(geometry.PLAYER_PLAY_SIZE))
    expect(width('Next track')).toBe(px(geometry.PLAYER_SKIP_SIZE))
    expect(width('Repeat off')).toBe(px(geometry.PLAYER_REPEAT_SIZE))
    expect(width('Show queue')).toBe(px(geometry.PLAYER_QUEUE_SIZE))
    expect(width('Volume, 100%')).toBe(px(geometry.PLAYER_VOLUME_SIZE))
  })

  it('spaces and pads the parts by the same sizes', () => {
    const container = renderPlayer(null)
    const bar = container.querySelector<HTMLElement>('[aria-label="Player"]')!
    expect(bar.style.paddingLeft).toBe(px(geometry.PLAYER_PADDING_LEFT))
    expect(bar.style.paddingRight).toBe(px(geometry.PLAYER_PADDING_RIGHT))
    expect(bar.style.gap).toBe(px(geometry.PLAYER_COLUMN_GAP))
    expect((bar.firstElementChild as HTMLElement).style.width).toBe(px(geometry.PLAYER_COVER_SIZE))

    const transport = container.querySelector('[aria-label="Previous track"]')!.closest('div')!
    expect(transport.style.gap).toBe(px(geometry.PLAYER_TRANSPORT_GAP))
    const queueAndVolume = container.querySelector('[aria-label="Show queue"]')!.closest('div')!
    expect(queueAndVolume.style.gap).toBe(px(geometry.PLAYER_QUEUE_VOLUME_GAP))

    const seek = container.querySelector<HTMLElement>('[aria-label="Seek"]')!
    expect(seek.style.gap).toBe(px(geometry.PLAYER_BAR_GAP))
    expect((seek.firstElementChild as HTMLElement).style.minWidth).toBe(px(geometry.PLAYER_BAR_MIN_WIDTH))
    expect(seek.parentElement!.style.gap).toBe(px(geometry.PLAYER_SCRUBBER_GAP))
    expect((seek.previousElementSibling as HTMLElement).style.width).toBe(px(geometry.PLAYER_TIME_WIDTH))
    expect((seek.nextElementSibling as HTMLElement).style.width).toBe(px(geometry.PLAYER_TIME_WIDTH))
  })
})

// #308: the idle pill takes the bar's place: its centre, and its width as a
// limit, giving way in its own order.
describe('IdlePlayer as the bar narrows', () => {
  const px = (n: number) => `${n}px`
  // Words on screen, without the icon's markup.
  const words = (el: Element) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    const out: string[] = []
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.textContent!.trim() && !node.parentElement!.closest('svg')) out.push(node.textContent!.trim())
    }
    return out
  }

  // One root, so a later width re-renders the same pill, as a resize does.
  function renderIdle(windowWidth: number) {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    const render = (width: number) => {
      const layout = computeShellLayout(width, 900, { leftOpen: true, rightOpen: true })
      act(() => {
        root.render(
          createElement(
            ShellLayoutContext.Provider,
            { value: layout },
            createElement(IdlePlayer, { onShuffleLibrary: () => undefined, busy: false }),
          ),
        )
      })
      const pill = container.querySelector<HTMLElement>('[aria-label="Player"]')!
      return { layout, pill, text: words(pill), button: container.querySelector('button')! }
    }
    return { ...render(windowWidth), rerender: render }
  }

  // Hovers the button past the tooltip's dwell, and says what the tooltip shows.
  const tooltipOver = (button: HTMLElement) => {
    act(() => button.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })))
    act(() => vi.advanceTimersByTime(400))
    const text = document.querySelector('[role="tooltip"]')?.textContent ?? null
    act(() => button.dispatchEvent(new MouseEvent('pointerout', { bubbles: true })))
    return text
  }

  it('centres on the bar and draws at the sizes layout.ts adds up', () => {
    const { layout, pill } = renderIdle(1440)
    expect(pill.style.left).toBe(px(layout.playerCx))
    expect(pill.style.height).toBe(px(geometry.IDLE_HEIGHT))
    expect(pill.style.minWidth).toBe(px(geometry.IDLE_HEIGHT))
    expect(pill.style.gap).toBe(px(geometry.IDLE_GAP))
    expect(pill.style.paddingLeft).toBe(px(geometry.IDLE_PADDING_TEXT))
    expect(pill.style.paddingRight).toBe(px(geometry.IDLE_PADDING))
  })

  it('hugs its content on one line, never wider than the bar, and clips there', () => {
    const { layout, pill } = renderIdle(1000)
    // Without w-max the browser caps an absolute box at the room right of its left edge, and
    // "Nothing playing" wrapped onto two lines at 769–1045px with only the left panel open.
    expect(pill.classList).toContain('w-max')
    expect(pill.style.maxWidth).toBe(px(layout.playerWidth))
    expect(pill.classList).toContain('overflow-hidden')
    const sentence = renderIdle(1440).pill.firstElementChild!
    expect(sentence.textContent).toBe('Nothing playing')
    expect(sentence.classList).toContain('whitespace-nowrap')
    expect(sentence.classList).toContain('shrink-0')
  })

  // The button and the keycap are Button and Kbd, whose sizes are Tailwind
  // classes there. controlGeometry.ts keeps a second copy for layout.ts, so
  // check one against the other.
  it("draws the button and the keycap at controlGeometry.ts's sizes", () => {
    const { pill, button } = renderIdle(1440)
    expect(button.classList).toContain(`h-[${controls.BUTTON_MD_HEIGHT}px]`)
    expect(button.classList).toContain(`pl-[${controls.BUTTON_PADDING_LEFT}px]`)
    expect(button.classList).toContain(`pr-[${controls.BUTTON_PADDING_RIGHT}px]`)
    expect(button.classList).toContain(`gap-[${controls.BUTTON_ICON_GAP}px]`)
    expect(button.querySelector<HTMLElement>('[aria-hidden="true"]')!.style.width).toBe(px(controls.BUTTON_ICON_SIZE))
    const kbd = pill.querySelector('kbd')!
    expect(kbd.classList).toContain(controls.KBD_BORDER === 1 ? 'border' : `border-[${controls.KBD_BORDER}px]`)
    expect(kbd.classList).toContain(`px-[${controls.KBD_PADDING}px]`)

    // Alone, the icon's button is a circle as wide as it is tall.
    const iconAlone = renderIdle(900).button
    expect(iconAlone.classList).toContain(`h-[${controls.BUTTON_MD_HEIGHT}px]`)
    expect(iconAlone.classList).toContain('aspect-square')
  })

  it('shows everything in a wide bar', () => {
    expect(renderIdle(1440).text).toEqual(['Nothing playing', 'Shuffle library', 'space'])
  })

  it('drops the space keycap at the narrowest desktop window', () => {
    expect(renderIdle(1100).text).toEqual(['Nothing playing', 'Shuffle library'])
  })

  it('comes down to the button, then its icon, named for screen readers', () => {
    const buttonAlone = renderIdle(1000)
    expect(buttonAlone.text).toEqual(['Shuffle library'])
    expect(buttonAlone.pill.style.paddingLeft).toBe(px(geometry.IDLE_PADDING))

    const iconAlone = renderIdle(900)
    expect(iconAlone.text).toEqual([])
    expect(iconAlone.button.getAttribute('aria-label')).toBe('Shuffle library')
  })

  it('keeps one button, and a keyboard user on it, through every width', () => {
    const idle = renderIdle(1440)
    act(() => idle.button.focus())
    for (const width of [1100, 1000, 900, 1000, 1440]) {
      const { button } = idle.rerender(width)
      expect(button, `window ${width}`).toBe(idle.button)
      expect(document.activeElement, `window ${width}`).toBe(idle.button)
    }
  })

  it('says space starts it once the keycap has gone, at every width', () => {
    vi.useFakeTimers()
    // With the keycap showing, a tooltip would only repeat the pill.
    expect(tooltipOver(renderIdle(1440).button)).toBeNull()
    // The labelled button (every window from 980 to 1151px with both panels open), then the icon alone.
    expect(tooltipOver(renderIdle(1100).button)).toBe('Shuffle libraryspace')
    expect(tooltipOver(renderIdle(1000).button)).toBe('Shuffle libraryspace')
    expect(tooltipOver(renderIdle(900).button)).toBe('Shuffle libraryspace')
  })
})
