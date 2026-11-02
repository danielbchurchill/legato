/* Which node a finger or the mouse means.
 *
 * Sigma picks a node by the pixel under the pointer, so it only hits inside a
 * dot's drawn radius: 1.5px for a track at camera ratio 1. That's far smaller
 * than a fingertip about 44pt across (#409), and too small to hit with a mouse
 * at speed (#450). Both take the nearest drawn node within a reach of the
 * pointer instead, measured on screen: TAP_REACH_PX for a finger,
 * MOUSE_REACH_PX for the mouse.
 *
 * Distance runs from the pointer to a dot's drawn edge, not its centre. A
 * pointer that lands on a dot is then always 0px from it, so it hits that dot
 * as sigma's own pick would, and a large artist reaches as far past its edge
 * as a track does past its own. Measured to centres, a pointer resting on an
 * artist could pick a track whose centre happened to sit nearer.
 *
 * Neither a finger nor a hand moving a mouse is precise to a few pixels, so
 * every node within NEAR_TIE_PX of the nearest one ties with it, and the one
 * a person most likely meant wins: one whose label is showing, then the
 * larger, then the nearer. At the overview, a pointer between a record and its
 * tracks takes the record; zooming in spreads dots apart faster than it grows
 * them, and a track can be picked out on its own. */

import type { Point } from './touchGestures'

/** Half a 44pt fingertip. */
export const TAP_REACH_PX = 22
/** The mouse's reach: 11px past a track's 1.5px radius makes it a 25px
 * target at the overview, just over WCAG 2.5.8's 24px minimum. Half a
 * finger's, because a pointer lands where it's aimed. Among a cluster's dots
 * the nearest one decides whatever the reach; what a longer reach takes is
 * the clear map where a click clears the selection. Zoomed in on a
 * 5,000-node map (#450), 56% of the screen stays clear at 11px, against 25%
 * at a finger's 22px. */
export const MOUSE_REACH_PX = 11
/** How much further than the nearest node another one can be and still tie. */
export const NEAR_TIE_PX = 4

export type TapCandidate = {
  key: string
  /** The dot's centre, in viewport px. */
  x: number
  y: number
  /** Its drawn radius, in viewport px. */
  radius: number
  /** Whether its label is drawn right now. */
  labelled: boolean
  /** Hidden by the node reducer, so not drawn. */
  hidden?: boolean
}

type InReach = { node: TapCandidate; distance: number }

/** The key of the node a pointer at `point` means, or null when no drawn node
 * is within `reach` px of it. A node counts when it isn't hidden and some of
 * it is inside the viewport. */
export function pickNearestNode(
  point: Point,
  candidates: Iterable<TapCandidate>,
  viewport: { width: number; height: number },
  reach: number,
): string | null {
  const inReach: InReach[] = []
  let nearest = Infinity
  for (const node of candidates) {
    if (node.hidden) continue
    const { x, y, radius } = node
    // Cheap rejections first: this runs over every node on each mousemove.
    if (x + radius < 0 || x - radius > viewport.width || y + radius < 0 || y - radius > viewport.height) continue
    const span = reach + radius
    if (Math.abs(x - point.x) > span || Math.abs(y - point.y) > span) continue
    const distance = Math.max(0, Math.hypot(x - point.x, y - point.y) - radius)
    if (distance > reach) continue
    inReach.push({ node, distance })
    if (distance < nearest) nearest = distance
  }
  let best: InReach | null = null
  for (const candidate of inReach) {
    if (candidate.distance > nearest + NEAR_TIE_PX) continue
    if (best == null || beats(candidate, best)) best = candidate
  }
  return best?.node.key ?? null
}

/** The node a tap at `tap` means (#409). */
export function pickTapTarget(tap: Point, candidates: Iterable<TapCandidate>, viewport: { width: number; height: number }): string | null {
  return pickNearestNode(tap, candidates, viewport, TAP_REACH_PX)
}

/** The node the mouse at `pointer` means (#450): the one a click selects and
 * hover shows. */
export function pickMouseTarget(
  pointer: Point,
  candidates: Iterable<TapCandidate>,
  viewport: { width: number; height: number },
): string | null {
  return pickNearestNode(pointer, candidates, viewport, MOUSE_REACH_PX)
}

function beats(a: InReach, b: InReach): boolean {
  if (a.node.labelled !== b.node.labelled) return a.node.labelled
  if (a.node.radius !== b.node.radius) return a.node.radius > b.node.radius
  return a.distance < b.distance
}
