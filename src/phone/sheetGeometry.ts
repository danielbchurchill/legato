/* The phone sheet's arithmetic (#389), kept apart from the component so the
 * gesture's decisions can be tested on their own: where each detent sits,
 * where a release lands, and when a drag in the content moves the sheet
 * rather than scrolling it.
 *
 * Heights throughout are how much of the sheet shows above the bottom edge
 * of the viewport, in CSS px. Velocities are px/ms, positive when the
 * finger moves up, which is the sheet growing. */

export type Detent = 'peek' | 'medium' | 'large'

/** Lowest first. */
export const DETENTS: readonly Detent[] = ['peek', 'medium', 'large']

export type DetentHeights = Record<Detent, number>

/* Large leaves this strip of map under the status bar (the handoff's
 * "status bar + 64"). */
export const LARGE_TOP_GAP = 64
/* Medium puts the sheet's top edge this far down the viewport: the
 * handoff's node detail frame draws it at 40% of the screen's height. */
export const MEDIUM_TOP_FRACTION = 0.4

export function detentHeights({
  viewportHeight,
  safeTop,
  safeBottom,
  peekContent,
}: {
  viewportHeight: number
  safeTop: number
  safeBottom: number
  /** The header and the peek line, measured: what peek has to show. */
  peekContent: number
}): DetentHeights {
  const large = Math.max(0, viewportHeight - safeTop - LARGE_TOP_GAP)
  // Peek clears the home indicator or gesture bar.
  const peek = Math.min(large, peekContent + safeBottom)
  const medium = Math.min(large, Math.max(peek, viewportHeight - Math.round(viewportHeight * MEDIUM_TOP_FRACTION)))
  return { peek, medium, large }
}

/* A release at least this fast is a flick, and goes on to the next detent
 * whatever the position: 0.5 px/ms is 500px a second. */
export const FLICK_VELOCITY = 0.5
/* Slower than a flick, a release still carries on a little: it lands on
 * the detent nearest to where it would be this long after letting go. */
export const PROJECTION_MS = 150
/* A detent within this of the sheet counts as where it already is, so a
 * flick from a detent goes to the next one rather than the same one. */
const AT_DETENT = 4

export function snapDetent(heights: DetentHeights, height: number, velocity: number): Detent {
  if (Math.abs(velocity) >= FLICK_VELOCITY) {
    if (velocity > 0) return DETENTS.find((d) => heights[d] > height + AT_DETENT) ?? 'large'
    return [...DETENTS].reverse().find((d) => heights[d] < height - AT_DETENT) ?? 'peek'
  }
  const projected = height + velocity * PROJECTION_MS
  let nearest: Detent = 'peek'
  for (const d of DETENTS) if (Math.abs(heights[d] - projected) < Math.abs(heights[nearest] - projected)) nearest = d
  return nearest
}

/* Past peek or large the sheet still follows the finger, but less and less,
 * as a native sheet does, and settles back when it's let go. */
const RUBBER_BAND_LIMIT = 120

function resist(overshoot: number): number {
  return (1 - 1 / ((overshoot * 0.55) / RUBBER_BAND_LIMIT + 1)) * RUBBER_BAND_LIMIT
}

export function rubberBand(height: number, heights: DetentHeights): number {
  if (height > heights.large) return heights.large + resist(height - heights.large)
  if (height < heights.peek) return heights.peek - resist(heights.peek - height)
  return height
}

/** 0 at medium or lower, 1 at large: how far the dim behind the sheet has
 * come in, and how far the controls over the map have gone. */
export function largeProgress(height: number, heights: DetentHeights): number {
  const span = heights.large - heights.medium
  if (span <= 0) return height >= heights.large ? 1 : 0
  return Math.min(1, Math.max(0, (height - heights.medium) / span))
}

/** 0 at peek, 1 at medium or higher: the peek line fades out and the tab's
 * content in over this. */
export function peekProgress(height: number, heights: DetentHeights): number {
  const span = heights.medium - heights.peek
  if (span <= 0) return height > heights.peek ? 1 : 0
  return Math.min(1, Math.max(0, (height - heights.peek) / span))
}

/** The handle as a button: peek, medium, large, then back to peek. */
export function nextDetent(detent: Detent): Detent {
  return DETENTS[(DETENTS.indexOf(detent) + 1) % DETENTS.length]
}

export type Sample = { y: number; t: number }

/* The release velocity is read over the last stretch of the drag only, so
 * a slow drag that ends in a flick counts as a flick. */
export const VELOCITY_WINDOW_MS = 100

/** The finger's speed at release, from the drag's recent samples (oldest
 * first). A finger that stopped before letting go has none. */
export function releaseVelocity(samples: readonly Sample[], releasedAt: number): number {
  if (samples.length < 2) return 0
  const last = samples[samples.length - 1]
  if (releasedAt - last.t > VELOCITY_WINDOW_MS) return 0
  const first = samples.find((s) => last.t - s.t <= VELOCITY_WINDOW_MS) ?? last
  const dt = last.t - first.t
  return dt > 0 ? (first.y - last.y) / dt : 0
}

/* A touch has to travel this far before it's a drag, so a tap on a button
 * in the header stays a tap. Under the browser's own slop, so a drag in the
 * content is claimed before the content starts to scroll. */
export const DRAG_SLOP = 6

/** Whether a vertical drag that starts in the sheet's content moves the
 * sheet rather than scrolling the content, as native sheets decide it: up
 * grows the sheet until it's large, then scrolls; down scrolls back to the
 * content's top, then shrinks the sheet. `dy` is the finger's movement,
 * positive downwards. */
export function contentDragMovesSheet({ detent, dy, scrolledToTop }: { detent: Detent; dy: number; scrolledToTop: boolean }): boolean {
  if (dy < 0) return detent !== 'large'
  return scrolledToTop
}
