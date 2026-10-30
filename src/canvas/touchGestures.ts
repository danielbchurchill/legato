/* The map's touch gestures, as pure logic.
 *
 * Sigma's touch captor pans with one finger, and that stays. Its two-finger
 * gesture doesn't: it zooms about the first finger rather than between the
 * two, so a pinch slides the map sideways, and it also rotates the camera.
 * Canvas.tsx takes over the two-finger move with pinchCameraState, and uses
 * TapGuard to keep a gesture that pinched or travelled from also counting
 * as a tap when the last finger lifts. */

export type Point = { x: number; y: number }
export type CameraState = { x: number; y: number; ratio: number; angle: number }

export function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

/** The camera for a pinch that started at `from` with the camera at
 * `start` and is now at `to`: zoomed by how far the fingers spread, and
 * moved so the point that was between them stays between them. No rotation.
 *
 * `toFramed` converts a viewport point to sigma's framed graph space under a
 * given camera, and `bound` clamps a ratio to the camera's limits. A camera
 * move shifts every framed point by the same amount at any angle and zoom,
 * so the fix-up after zooming is a plain translation. */
export function pinchCameraState(
  start: CameraState,
  from: readonly [Point, Point],
  to: readonly [Point, Point],
  toFramed: (point: Point, camera: CameraState) => Point,
  bound: (ratio: number) => number,
): CameraState {
  const spreadFrom = distance(from[0], from[1])
  const spreadTo = distance(to[0], to[1])
  const ratio = spreadFrom > 0 && spreadTo > 0 ? bound((start.ratio * spreadFrom) / spreadTo) : start.ratio
  const anchor = toFramed(midpoint(from[0], from[1]), start)
  const zoomed = { ...start, ratio }
  const under = toFramed(midpoint(to[0], to[1]), zoomed)
  return { ...zoomed, x: start.x + anchor.x - under.x, y: start.y + anchor.y - under.y }
}

/* Sigma reports a tap when the last finger lifts within its tolerance of
 * where the last touchdown put it. After a pinch, that touchdown is the
 * finger left on the glass, so lifting it taps whatever is under it, and a
 * pan that comes back to where it began taps too. A tap is only a tap if
 * one finger went down on its own and never travelled further than the
 * tolerance. */
export const TAP_TOLERANCE_PX = 10

export class TapGuard {
  private origin: Point | null = null
  private spoiled = false

  /** A finger went down. `fresh` when it began a new gesture (the first
   * finger on the glass), not a finger lifting off a pinch. */
  down(touches: readonly Point[], fresh: boolean): void {
    if (fresh) {
      this.spoiled = false
      this.origin = touches[0] ?? null
    }
    if (touches.length !== 1) this.spoiled = true
  }

  move(touches: readonly Point[]): void {
    if (this.spoiled) return
    if (touches.length !== 1 || !this.origin) {
      this.spoiled = true
      return
    }
    if (distance(this.origin, touches[0]) > TAP_TOLERANCE_PX) this.spoiled = true
  }

  allowsTap(): boolean {
    return !this.spoiled
  }
}

/** Whether a sigma event came from a touch rather than a mouse. */
export function isTouchEvent(original: Event): boolean {
  return 'touches' in original
}

/** Whether a touch event's touch came from a stylus: Safari reports an
 * Apple Pencil as a touch whose touchType is 'stylus'. */
export function isStylusTouch(original: Event): boolean {
  const touch = (original as TouchEvent).changedTouches?.[0] as (Touch & { touchType?: string }) | undefined
  return touch?.touchType === 'stylus'
}
