/* The measurement ScrollingText makes on every resize, pulled out as plain
 * functions so the two decisions that hang off it — "is anything actually
 * hidden?" and "what static reveal does it get?" — are testable without a
 * layout engine.
 *
 * Issue #86: a truncated value has to have *some* way to be read in full.
 * The hover marquee is one, but it is switched off under reduced motion and
 * never runs without a pointer, so it can't be the only one. A native
 * `title` is the static fallback: it costs no motion, works with reduced
 * motion on, and is set only when text really is cut off, so a value that
 * fits never grows a tooltip that just repeats it. */

// Sub-pixel layout rounding shouldn't be enough to count as overflow — a
// scroll that moves nothing a viewer could perceive, or a tooltip repeating
// text that is already fully visible, are both worse than nothing.
export const MIN_OVERFLOW_PX = 1

/** Pixels of text hidden past the container's edge, or 0 when it fits. */
export function overflowPx(textWidth: number, containerWidth: number): number {
  const overflow = Math.ceil(textWidth - containerWidth)
  return overflow > MIN_OVERFLOW_PX ? overflow : 0
}

/** The `title` a truncated field carries: the full text while any of it is
 * hidden, nothing while it fits. */
export function revealTitle(text: string, hiddenPx: number): string | undefined {
  return hiddenPx > 0 ? text : undefined
}
