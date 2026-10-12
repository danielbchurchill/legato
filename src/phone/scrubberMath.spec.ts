import { describe, expect, it } from 'vitest'
import { scrubberTimes, seekFraction, seekPosition } from './scrubberMath'

describe('seekFraction', () => {
  it('reads a finger along the track, 0 at its left end and 1 at its right', () => {
    expect(seekFraction(20, 20, 300)).toBe(0)
    expect(seekFraction(170, 20, 300)).toBe(0.5)
    expect(seekFraction(320, 20, 300)).toBe(1)
  })

  it('pins a finger past either end to that end', () => {
    expect(seekFraction(-40, 20, 300)).toBe(0)
    expect(seekFraction(900, 20, 300)).toBe(1)
  })

  it('reads a track with no width as its start', () => {
    expect(seekFraction(100, 20, 0)).toBe(0)
  })
})

describe('seekPosition', () => {
  it('turns a fraction of the track into whole ms', () => {
    expect(seekPosition(0.6, 205_000)).toBe(123_000)
    expect(seekPosition(1 / 3, 100)).toBe(33)
    expect(seekPosition(2, 1000)).toBe(1000)
  })
})

describe('scrubberTimes', () => {
  it('writes elapsed and what is left with a minus sign, as the handoff draws them', () => {
    expect(scrubberTimes(156_000, 412_000)).toEqual({ elapsed: '2:36', remaining: '−4:16' })
  })

  it('adds up to the track length rather than drifting a second apart', () => {
    // Rounded each on its own, they'd be 2:36 and 4:17: 6:53 in all.
    const { elapsed, remaining } = scrubberTimes(155_500, 412_000)
    expect(elapsed).toBe('2:35')
    expect(remaining).toBe('−4:17')
  })

  it('stops at the end of the track', () => {
    expect(scrubberTimes(500_000, 412_000)).toEqual({ elapsed: '6:52', remaining: '−0:00' })
  })

  it('has nothing to count down with no length known', () => {
    expect(scrubberTimes(5_000, null)).toEqual({ elapsed: '0:05', remaining: '—' })
  })
})
