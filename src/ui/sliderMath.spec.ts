import { describe, expect, it } from 'vitest'
import { fractionToValue, nearestThumb, nudge, snapToStep, stepDecimals, valueToFraction } from './sliderMath'

describe('stepDecimals', () => {
  it('reads decimal places off a step', () => {
    expect(stepDecimals(1)).toBe(0)
    expect(stepDecimals(0.01)).toBe(2)
    expect(stepDecimals(0.25)).toBe(2)
    expect(stepDecimals(1e-7)).toBe(7)
  })
})

describe('snapToStep', () => {
  it('anchors the grid at min, not at zero', () => {
    expect(snapToStep(23, 20, 300, 5)).toBe(25)
    expect(snapToStep(22, 20, 300, 5)).toBe(20)
  })

  it('strips floating-point noise', () => {
    expect(snapToStep(0.1 + 0.2, 0, 1, 0.01)).toBe(0.3)
  })

  it('keeps max reachable when the range is not a whole number of steps', () => {
    expect(snapToStep(9.9, 0, 10, 3)).toBe(9)
    expect(snapToStep(10, 0, 10, 3)).toBe(10)
  })
})

describe('linear and logarithmic fractions', () => {
  it('round-trips linearly', () => {
    expect(valueToFraction(150, 100, 200)).toBe(0.5)
    expect(fractionToValue(0.5, 100, 200)).toBe(150)
  })

  it('puts the geometric mean at the middle of a log track', () => {
    expect(valueToFraction(10, 1, 100, 'logarithmic')).toBeCloseTo(0.5)
    expect(fractionToValue(0.5, 1, 100, 'logarithmic')).toBeCloseTo(10)
  })

  it('falls back to linear when a log range touches zero', () => {
    expect(valueToFraction(50, 0, 100, 'logarithmic')).toBe(0.5)
  })
})

describe('nudge', () => {
  const linear = { min: 0, max: 1, step: 0.01, scale: 'linear' as const }

  it('moves one step, ten on a page key, and clamps', () => {
    expect(nudge(0.5, 1, false, linear)).toBe(0.51)
    expect(nudge(0.5, -1, true, linear)).toBe(0.4)
    expect(nudge(0.995, 1, true, linear)).toBe(1)
  })

  it('moves a log slider by a constant share of the track', () => {
    const log = { min: 1, max: 1000, step: 0.001, scale: 'logarithmic' as const }
    const low = nudge(1, 1, false, log) - 1
    const high = nudge(500, 1, false, log) - 500
    expect(high).toBeGreaterThan(low * 100)
  })
})

describe('nearestThumb', () => {
  it('picks the nearer thumb', () => {
    expect(nearestThumb(0.1, 0.2, 0.8)).toBe(0)
    expect(nearestThumb(0.7, 0.2, 0.8)).toBe(1)
  })

  it('splits stacked thumbs by which side the press landed on', () => {
    expect(nearestThumb(0.4, 0.5, 0.5)).toBe(0)
    expect(nearestThumb(0.6, 0.5, 0.5)).toBe(1)
  })
})
