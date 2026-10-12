import { NO_VALUE } from '../ui/format'

/* The phone scrubber's arithmetic (#389, Legato Mobile v2 screens 6 and 7),
 * kept apart from the component so it can be tested on its own: where a
 * finger on the track seeks to, and what the readouts either side say. */

/** How far along the track a finger is, 0 at its left end and 1 at its
 * right, however far past either end it has gone. */
export function seekFraction(clientX: number, left: number, width: number): number {
  if (width <= 0) return 0
  return Math.min(1, Math.max(0, (clientX - left) / width))
}

/** The position a fraction of the track stands for, in whole ms. */
export function seekPosition(fraction: number, durationMs: number): number {
  return Math.round(Math.min(1, Math.max(0, fraction)) * durationMs)
}

/** What the arrow keys move the position by, as the desktop's waveform's do. */
export const SEEK_STEP_MS = 5000

const MINUS = '−'

function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** The readouts: elapsed, and what's left with a minus sign, as the
 * handoff draws them ("2:36", "−4:16"). Elapsed counts whole seconds gone,
 * and what's left is the rest of the track's rounded length, so the two
 * always add up to it rather than drifting a second apart. With no length
 * known, there's nothing left to count down, so it says there's no value. */
export function scrubberTimes(positionMs: number, durationMs: number | null): { elapsed: string; remaining: string } {
  const elapsed = Math.max(0, Math.floor(positionMs / 1000))
  if (durationMs == null || durationMs <= 0) return { elapsed: clock(elapsed), remaining: NO_VALUE }
  const total = Math.round(durationMs / 1000)
  const shown = Math.min(elapsed, total)
  return { elapsed: clock(shown), remaining: `${MINUS}${clock(total - shown)}` }
}
