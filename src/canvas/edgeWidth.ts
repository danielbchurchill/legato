/* How wide an unfocused map edge draws, in screen pixels, at a camera ratio
 * (sigma's: 1 frames the whole map, smaller is closer in).
 *
 * Steady from the overview in, thinner zoomed out. At the overview every
 * edge in the library is on screen at once, and an 11%-alpha hairline any
 * narrower sinks into the paper. Closer in it holds that width: sigma grows
 * the dots with the square root of the zoom, so the edges already get
 * lighter beside them. The previous curve narrowed them as well, to 0.7px,
 * and lost them against the dots; widening them turned a focused cluster's
 * edges, a third wider again and nearly opaque, into ribbons over its
 * tracks.
 *
 * Zoomed out, the dots shrink by the square root and the edges by the fourth
 * root, so a far-off map reads as the overview in miniature, not as the solid
 * starbursts the previous curve's 1.6px drew. The floor is where an 11% line
 * stops reading on paper at all; v2's 0.6px spec was under it. v1 drew every
 * edge at sigma's 1.7px floor at any zoom; this stays under that everywhere. */

export const EDGE_PX_AT_OVERVIEW = 1.3
export const EDGE_MIN_PX = 0.8

/* The map options' "line width" (#467) scales the whole rule: every zoom,
 * focused edges included, by one multiplier. The rule's floor scales with
 * it, so a thinner setting is the same curve drawn thinner. It's a new
 * setting rather than the shipped panel's `edgeThicknessMultiplier`, which
 * no control has written since v2: a library that set it long ago would
 * otherwise find its edges changed under it. */
export const EDGE_WIDTH_SCALE_KEY = 'edgeWidthScale'
export const EDGE_WIDTH_SCALE_DEFAULT = 1

/** The saved line width multiplier, or 1 when it's missing or isn't a
 * positive number. */
export function resolveEdgeWidthScale(settings: Record<string, string>): number {
  const raw = settings[EDGE_WIDTH_SCALE_KEY]
  const n = Number(raw)
  return raw != null && raw !== '' && Number.isFinite(n) && n > 0 ? n : EDGE_WIDTH_SCALE_DEFAULT
}

export function edgeWidthPx(cameraRatio: number, scale = EDGE_WIDTH_SCALE_DEFAULT): number {
  // Closer than the overview, or a ratio sigma never reports (0, NaN).
  if (!(cameraRatio > 1)) return EDGE_PX_AT_OVERVIEW * scale
  return Math.max(EDGE_MIN_PX, EDGE_PX_AT_OVERVIEW * cameraRatio ** -0.25) * scale
}
