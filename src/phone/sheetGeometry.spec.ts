import { describe, expect, it } from 'vitest'
import {
  FLICK_VELOCITY,
  LARGE_TOP_GAP,
  contentDragMovesSheet,
  detentHeights,
  dragOpensUpNext,
  largeProgress,
  nextDetent,
  peekProgress,
  releaseVelocity,
  rubberBand,
  snapDetent,
  type DetentHeights,
} from './sheetGeometry'

// The handoff's iPhone frame: 844 tall, a 54px status bar, a 34px home
// indicator, and a peek of about 171px of header and peek line.
const IPHONE = detentHeights({ viewportHeight: 844, safeTop: 54, safeBottom: 34, peekContent: 171 })

describe('detentHeights', () => {
  it('puts large under the status bar plus 64, medium at 40% down, and peek over the home indicator', () => {
    expect(IPHONE.large).toBe(844 - 54 - LARGE_TOP_GAP)
    // The sheet's top edge at 40% of 844 (338), so 506 of it shows.
    expect(IPHONE.medium).toBe(844 - 338)
    expect(IPHONE.peek).toBe(171 + 34)
  })

  it("leaves search's 70px of map at large when asked, with medium and peek where they were", () => {
    expect(detentHeights({ viewportHeight: 844, safeTop: 54, safeBottom: 34, peekContent: 150, largeTopGap: 70 })).toEqual({
      peek: 184,
      medium: 506,
      large: 720,
    })
  })

  it('keeps the detents in order on a short screen', () => {
    const short = detentHeights({ viewportHeight: 320, safeTop: 0, safeBottom: 0, peekContent: 200 })
    expect(short.peek).toBeLessThanOrEqual(short.medium)
    expect(short.medium).toBeLessThanOrEqual(short.large)
    // Peek never overshoots large, however tall its content.
    expect(detentHeights({ viewportHeight: 300, safeTop: 0, safeBottom: 0, peekContent: 400 }).peek).toBe(300 - LARGE_TOP_GAP)
  })

  it('is all zero before the viewport is measured', () => {
    expect(detentHeights({ viewportHeight: 0, safeTop: 0, safeBottom: 0, peekContent: 0 })).toEqual({ peek: 0, medium: 0, large: 0 })
  })
})

describe('snapDetent', () => {
  it('lands a slow release on the nearest detent', () => {
    expect(snapDetent(IPHONE, IPHONE.peek + 40, 0)).toBe('peek')
    expect(snapDetent(IPHONE, IPHONE.medium - 60, 0)).toBe('medium')
    expect(snapDetent(IPHONE, IPHONE.medium + 60, 0)).toBe('medium')
    expect(snapDetent(IPHONE, IPHONE.large - 30, 0)).toBe('large')
  })

  it('carries a release that is still moving a little further', () => {
    // Just short of halfway from peek to medium: at rest it's peek, but
    // moving up at 0.4 px/ms it projects 60px on, past halfway.
    const nearlyHalf = (IPHONE.peek + IPHONE.medium) / 2 - 20
    expect(snapDetent(IPHONE, nearlyHalf, 0)).toBe('peek')
    expect(snapDetent(IPHONE, nearlyHalf, 0.4)).toBe('medium')
  })

  it('sends a flick to the next detent in its direction, never past it', () => {
    expect(snapDetent(IPHONE, IPHONE.peek, FLICK_VELOCITY)).toBe('medium')
    expect(snapDetent(IPHONE, IPHONE.medium, FLICK_VELOCITY * 4)).toBe('large')
    expect(snapDetent(IPHONE, IPHONE.large, -FLICK_VELOCITY)).toBe('medium')
    expect(snapDetent(IPHONE, IPHONE.medium, -FLICK_VELOCITY * 4)).toBe('peek')
  })

  it('takes the next detent from where the sheet is, not where the drag began', () => {
    // Dragged most of the way from peek to large, then flicked: large.
    expect(snapDetent(IPHONE, IPHONE.large - 40, FLICK_VELOCITY)).toBe('large')
    // Dragged up past medium, then flicked back down: medium.
    expect(snapDetent(IPHONE, IPHONE.medium + 100, -FLICK_VELOCITY)).toBe('medium')
  })

  it('stays at the end it was flicked past', () => {
    expect(snapDetent(IPHONE, IPHONE.large + 30, FLICK_VELOCITY)).toBe('large')
    expect(snapDetent(IPHONE, IPHONE.peek - 30, -FLICK_VELOCITY)).toBe('peek')
  })
})

describe('rubberBand', () => {
  it('follows the finger between peek and large', () => {
    expect(rubberBand(IPHONE.medium, IPHONE)).toBe(IPHONE.medium)
  })

  it('gives less and less past either end', () => {
    const over = (by: number) => rubberBand(IPHONE.large + by, IPHONE) - IPHONE.large
    expect(over(40)).toBeGreaterThan(0)
    expect(over(40)).toBeLessThan(40)
    expect(over(400) - over(200)).toBeLessThan(over(200) - over(0))
    expect(over(10_000)).toBeLessThan(120)
    expect(rubberBand(IPHONE.peek - 40, IPHONE)).toBeGreaterThan(IPHONE.peek - 40)
    expect(rubberBand(IPHONE.peek - 40, IPHONE)).toBeLessThan(IPHONE.peek)
  })
})

describe('progress', () => {
  it('dims from medium to large, and not below medium', () => {
    expect(largeProgress(IPHONE.peek, IPHONE)).toBe(0)
    expect(largeProgress(IPHONE.medium, IPHONE)).toBe(0)
    expect(largeProgress((IPHONE.medium + IPHONE.large) / 2, IPHONE)).toBeCloseTo(0.5)
    expect(largeProgress(IPHONE.large + 50, IPHONE)).toBe(1)
  })

  it('swaps the peek line for the content between peek and medium', () => {
    expect(peekProgress(IPHONE.peek, IPHONE)).toBe(0)
    expect(peekProgress(IPHONE.medium, IPHONE)).toBe(1)
    expect(peekProgress(IPHONE.large, IPHONE)).toBe(1)
  })

  it('reads a collapsed span as a step', () => {
    const flat: DetentHeights = { peek: 200, medium: 200, large: 200 }
    expect(largeProgress(200, flat)).toBe(1)
    expect(peekProgress(200, flat)).toBe(0)
  })
})

describe('nextDetent', () => {
  it('steps the handle through the detents and round again', () => {
    expect(nextDetent('peek')).toBe('medium')
    expect(nextDetent('medium')).toBe('large')
    expect(nextDetent('large')).toBe('peek')
  })
})

describe('releaseVelocity', () => {
  it('reads upward movement as positive, in px/ms', () => {
    expect(
      releaseVelocity(
        [
          { y: 500, t: 0 },
          { y: 450, t: 50 },
          { y: 400, t: 100 },
        ],
        100,
      ),
    ).toBeCloseTo(1)
    expect(
      releaseVelocity(
        [
          { y: 400, t: 0 },
          { y: 460, t: 60 },
        ],
        60,
      ),
    ).toBeCloseTo(-1)
  })

  it('counts only the last 100ms, so a slow drag ending in a flick is a flick', () => {
    const samples = [
      { y: 600, t: 0 },
      { y: 590, t: 400 },
      { y: 580, t: 800 },
      // The flick: 80px in the last 80ms.
      { y: 540, t: 840 },
      { y: 500, t: 880 },
    ]
    expect(releaseVelocity(samples, 880)).toBeGreaterThanOrEqual(FLICK_VELOCITY)
  })

  it('has no speed when the finger stopped before letting go', () => {
    expect(
      releaseVelocity(
        [
          { y: 500, t: 0 },
          { y: 300, t: 50 },
        ],
        300,
      ),
    ).toBe(0)
  })

  it('has no speed without two samples', () => {
    expect(releaseVelocity([], 0)).toBe(0)
    expect(releaseVelocity([{ y: 10, t: 0 }], 0)).toBe(0)
  })
})

describe('contentDragMovesSheet', () => {
  it('grows the sheet on a drag up until it is large, then lets the content scroll', () => {
    expect(contentDragMovesSheet({ detent: 'peek', dy: -10, scrolledToTop: true })).toBe(true)
    expect(contentDragMovesSheet({ detent: 'medium', dy: -10, scrolledToTop: false })).toBe(true)
    expect(contentDragMovesSheet({ detent: 'large', dy: -10, scrolledToTop: true })).toBe(false)
  })

  it('shrinks the sheet on a drag down only once the content is back at its top', () => {
    expect(contentDragMovesSheet({ detent: 'large', dy: 10, scrolledToTop: true })).toBe(true)
    expect(contentDragMovesSheet({ detent: 'large', dy: 10, scrolledToTop: false })).toBe(false)
    expect(contentDragMovesSheet({ detent: 'medium', dy: 10, scrolledToTop: false })).toBe(false)
  })
})

describe('dragOpensUpNext', () => {
  it('opens up next when the mini player is dragged up, to whichever detent', () => {
    expect(dragOpensUpNext({ current: 'peek', next: 'medium', fromMiniPlayer: true })).toBe(true)
    expect(dragOpensUpNext({ current: 'peek', next: 'large', fromMiniPlayer: true })).toBe(true)
    expect(dragOpensUpNext({ current: 'medium', next: 'large', fromMiniPlayer: true })).toBe(true)
  })

  it('keeps the tab for a drag down, or one that starts anywhere else', () => {
    expect(dragOpensUpNext({ current: 'large', next: 'peek', fromMiniPlayer: true })).toBe(false)
    expect(dragOpensUpNext({ current: 'peek', next: 'large', fromMiniPlayer: false })).toBe(false)
  })
})
