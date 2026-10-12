import { DRAG_SLOP, FLICK_VELOCITY } from './sheetGeometry'

/* Up next's row gestures on a phone (#389, Legato Mobile v2 screen 6),
 * kept apart from the list so their decisions can be tested on their own.
 * The desktop reorders up next by dragging a row and removes one with the
 * Delete key; a phone has neither a mouse drag nor a keyboard, so it takes
 * the gestures native lists use:
 *
 *  - Hold a row still for LONG_PRESS_MS to lift it, then drag it to its new
 *    place; the rows it passes make room. Near the top or bottom of the
 *    list it scrolls on its own.
 *  - Swipe a row left to show "remove" behind it, and tap that; a swipe
 *    most of the way across removes it on its own.
 *
 * Distances are CSS px; velocities px/ms, positive leftwards for a swipe. */

/** The handoff's queue rows are 58px tall. */
export const ROW_HEIGHT = 58

/** How long a finger has to stay put before the row lifts. Under the
 * system's own long press (about 500ms), so the row lifts before Android
 * thinks of a context menu. */
export const LONG_PRESS_MS = 350

/** Whether a finger has moved too far for a hold: past this it's a scroll,
 * a swipe or a drag of the sheet, the same slop the sheet waits for. */
export function holdBroken(dx: number, dy: number): boolean {
  return Math.max(Math.abs(dx), Math.abs(dy)) >= DRAG_SLOP
}

/** Where a lifted row would land, `dy` px from where it started. */
export function reorderTarget(from: number, dy: number, count: number, rowHeight = ROW_HEIGHT): number {
  return Math.min(count - 1, Math.max(0, from + Math.round(dy / rowHeight)))
}

/** How far a row moves to make room while the row at `from` hovers over
 * `to`: the rows between slide one place towards where it came from. */
export function rowShift(index: number, from: number, to: number, rowHeight = ROW_HEIGHT): number {
  if (index === from) return 0
  if (from < to && index > from && index <= to) return -rowHeight
  if (from > to && index >= to && index < from) return rowHeight
  return 0
}

/** The list order once the row at `from` has moved to `to`, as
 * moveUpNext leaves it. */
export function moveEntry<T>(entries: readonly T[], from: number, to: number): T[] {
  const next = entries.slice()
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

/* A lifted row within this of the list's visible top or bottom scrolls it,
 * faster the closer it gets, up to EDGE_SPEED at the edge itself. */
export const EDGE_ZONE = 56
export const EDGE_SPEED = 0.6

/** How fast the list scrolls under a lifted row at `y`, between the
 * scroller's visible `top` and `bottom`: negative scrolls up. */
export function edgeScrollSpeed(y: number, top: number, bottom: number): number {
  if (y < top + EDGE_ZONE) return -EDGE_SPEED * Math.min(1, (top + EDGE_ZONE - y) / EDGE_ZONE)
  if (y > bottom - EDGE_ZONE) return EDGE_SPEED * Math.min(1, (y - (bottom - EDGE_ZONE)) / EDGE_ZONE)
  return 0
}

/** How wide "remove" is behind a row swiped open. */
export const SWIPE_ACTION_WIDTH = 88

/** A swipe past this fraction of the row's width removes the row on its own. */
export const FULL_SWIPE_FRACTION = 0.6

/** How far the row has moved left, from where the swipe began (`start`,
 * the action's width if the row was already open) and the finger's `dx`
 * (negative leftwards). It never moves right of closed, nor past its own
 * width. */
export function swipeOffset(start: number, dx: number, width: number): number {
  return Math.min(width, Math.max(0, start - dx))
}

export type SwipeEnd = 'closed' | 'open' | 'remove'

/** Where a swipe settles when the finger lets go: most of the way across
 * removes the row; a flick opens or closes it whichever way it went;
 * otherwise it stays open once "remove" is half showing. */
export function swipeRelease({ offset, velocity, width }: { offset: number; velocity: number; width: number }): SwipeEnd {
  if (offset >= width * FULL_SWIPE_FRACTION) return 'remove'
  if (velocity >= FLICK_VELOCITY) return 'open'
  if (velocity <= -FLICK_VELOCITY) return 'closed'
  return offset >= SWIPE_ACTION_WIDTH / 2 ? 'open' : 'closed'
}
