/* How wide an unfocused map edge draws, in screen pixels, at a camera ratio
 * (sigma's: 1 frames the whole map, smaller is closer in).
 *
 * Wider zoomed out, narrower zoomed in. At the overview every edge in the
 * library is on screen at once, and an 11%-alpha hairline sinks into the
 * paper; up close there are a few dozen, and a heavy line crowds the dots.
 * v1 drew every edge at sigma's 1.7px floor at any zoom; this stays under
 * that everywhere.
 *
 * Square-root falloff, so halving the zoom doesn't halve the line. The floor
 * is wider than v2's 0.6px spec because at 11% alpha a 0.6px line can't be
 * seen on paper at all, and the cap stops a zoom out past the overview from
 * turning the map into ribbons. */

export const EDGE_PX_AT_OVERVIEW = 1.3
export const EDGE_MIN_PX = 0.7
export const EDGE_MAX_PX = 1.6

export function edgeWidthPx(cameraRatio: number): number {
  if (!(cameraRatio > 0)) return EDGE_PX_AT_OVERVIEW
  return Math.min(EDGE_MAX_PX, Math.max(EDGE_MIN_PX, EDGE_PX_AT_OVERVIEW * Math.sqrt(cameraRatio)))
}
