import { describe, expect, it } from 'vitest'
import { DISMISS_FRACTION, dismissesOnRelease } from './nowPlayingGesture'
import { FLICK_VELOCITY } from './sheetGeometry'

const HEIGHT = 844

describe('dismissesOnRelease', () => {
  it('closes once pulled a quarter of the way down, however slowly', () => {
    expect(dismissesOnRelease({ offset: HEIGHT * DISMISS_FRACTION, velocity: 0, height: HEIGHT })).toBe(true)
    expect(dismissesOnRelease({ offset: HEIGHT * DISMISS_FRACTION - 1, velocity: 0, height: HEIGHT })).toBe(false)
  })

  it('closes on a flick down from anywhere', () => {
    expect(dismissesOnRelease({ offset: 30, velocity: FLICK_VELOCITY, height: HEIGHT })).toBe(true)
  })

  it('stays on a flick back up, however far it was pulled', () => {
    expect(dismissesOnRelease({ offset: 400, velocity: -FLICK_VELOCITY, height: HEIGHT })).toBe(false)
  })

  it("doesn't close for a flick that never moved it", () => {
    expect(dismissesOnRelease({ offset: 0, velocity: 2, height: HEIGHT })).toBe(false)
  })
})
