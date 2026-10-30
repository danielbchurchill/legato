/* Which node a finger means.
 *
 * Sigma picks a node by the pixel under the pointer, so a tap only hits
 * inside a dot's drawn radius: 1.5px for a track at camera ratio 1, against
 * a fingertip about 44pt across. A finger takes the nearest drawn node within
 * TAP_REACH_PX of the tap instead, measured on screen.
 *
 * Distance runs from the tap to a dot's drawn edge, not its centre. A tap
 * that lands on a dot is then always 0px from it, so it hits that dot as a
 * mouse would, and a large artist reaches as far past its edge as a track
 * does past its own. Measured to centres, a finger resting on an artist could
 * pick a track whose centre happened to sit nearer.
 *
 * A finger isn't precise to a few pixels, so every node within NEAR_TIE_PX of
 * the nearest one ties with it, and the one a person most likely meant wins:
 * one whose label is showing, then the larger, then the nearer. At the
 * overview, a tap between a record and its tracks takes the record; zooming
 * in spreads dots apart faster than it grows them, and a track can be picked
 * out on its own. */

import type { Point } from './touchGestures'

/** Half a 44pt fingertip. */
export const TAP_REACH_PX = 22
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

/** The key of the node a tap at `tap` means, or null when no drawn node is
 * in reach. A node counts when it isn't hidden and some of it is inside the
 * viewport. */
export function pickTapTarget(tap: Point, candidates: Iterable<TapCandidate>, viewport: { width: number; height: number }): string | null {
  const inReach: InReach[] = []
  let nearest = Infinity
  for (const node of candidates) {
    if (node.hidden) continue
    const { x, y, radius } = node
    if (x + radius < 0 || x - radius > viewport.width || y + radius < 0 || y - radius > viewport.height) continue
    const distance = Math.max(0, Math.hypot(x - tap.x, y - tap.y) - radius)
    if (distance > TAP_REACH_PX) continue
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

function beats(a: InReach, b: InReach): boolean {
  if (a.node.labelled !== b.node.labelled) return a.node.labelled
  if (a.node.radius !== b.node.radius) return a.node.radius > b.node.radius
  return a.distance < b.distance
}
