/* The library's geometry lives in tokens.css (--library-*), measured from
 * the v2 frame. The virtualisers need some of it as numbers, so they read
 * it back from the computed style rather than keeping a second copy that
 * could drift. Null until the stylesheet has applied, so a caller can wait
 * a frame instead of virtualising against a guess. */
export function readPx(element: Element, name: string): number | null {
  const value = Number.parseFloat(getComputedStyle(element).getPropertyValue(name))
  return Number.isFinite(value) && value > 0 ? value : null
}
