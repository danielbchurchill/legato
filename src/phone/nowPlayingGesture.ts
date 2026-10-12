import { FLICK_VELOCITY } from './sheetGeometry'

/* Now playing's swipe down (#389, Legato Mobile v2 screen 7), kept apart
 * from the screen so its decision can be tested on its own. The screen
 * follows the finger down, and on release either closes or springs back
 * up, as a native full-screen player does. */

/** A release this far down the screen closes it, however slowly. */
export const DISMISS_FRACTION = 0.25

/** Whether a swipe down closes Now playing: `offset` is how far down the
 * screen has been pulled (px), `velocity` the finger's speed at release
 * (px/ms, positive downwards), `height` the screen's. A flick closes it
 * from anywhere and a flick back up keeps it; otherwise it closes once it's
 * a quarter of the way down. */
export function dismissesOnRelease({ offset, velocity, height }: { offset: number; velocity: number; height: number }): boolean {
  if (velocity >= FLICK_VELOCITY) return offset > 0
  if (velocity <= -FLICK_VELOCITY) return false
  return offset >= height * DISMISS_FRACTION
}
