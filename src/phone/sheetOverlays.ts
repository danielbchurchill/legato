import type { SheetOverlay } from './navigation'
import type { Detent } from './sheetGeometry'

/* What the sheet's detent does as its overlays come and go (#389), kept apart
 * from the shell so it can be tested on its own. An overlay opens at its own
 * detent: search's results at large, under the field, and a node's detail
 * at medium, with the node centred on the map above it. Going back puts
 * the sheet where it was when the overlay went over it, so back from a node
 * opened in the library finds the library as tall as it was, and back from
 * a node opened on the map finds the player at peek. */

/** The detent each overlay opens at. */
export const OVERLAY_DETENT: Record<SheetOverlay['kind'], Detent> = { search: 'large', node: 'medium' }

/** Where the sheet goes back to with nothing remembered: the tabs at peek,
 * an overlay at its own detent. */
const ROOT_DETENT: Detent = 'peek'

/** An overlay's place in the history: its index, or -1 for the tabs under
 * every overlay. */
export type Depth = number

export type OverlayTransition = {
  detent: Detent
  /** By depth, the detent each covered overlay was at when something opened
   * over it. */
  saved: Map<Depth, Detent>
}

function same(a: SheetOverlay, b: SheetOverlay): boolean {
  return a.kind === b.kind && (a.kind === 'search' || (b.kind === 'node' && a.id === b.id))
}

/** Where the sheet goes when its overlays change from `before` to `after`,
 * with the sheet at `detent` and `saved` remembered; null when nothing
 * changed. */
export function overlayTransition(
  before: readonly SheetOverlay[],
  after: readonly SheetOverlay[],
  detent: Detent,
  saved: ReadonlyMap<Depth, Detent>,
): OverlayTransition | null {
  let common = 0
  while (common < before.length && common < after.length && same(before[common], after[common])) common++
  if (common === before.length && common === after.length) return null

  // Nothing deeper than what's left in common is coming back.
  const next = new Map([...saved].filter(([depth]) => depth < common))

  if (after.length === common) {
    // Back: to where the overlay now on top was when it was covered.
    const depth = common - 1
    const top = after[depth]
    const back = next.get(depth) ?? (top ? OVERLAY_DETENT[top.kind] : ROOT_DETENT)
    next.delete(depth)
    return { detent: back, saved: next }
  }

  // Something new on top. Pushed over what was showing, that's covered now,
  // at the detent it's at; in place of what was on top, what's under it
  // stays covered as it was.
  if (common === before.length) next.set(common - 1, detent)
  return { detent: OVERLAY_DETENT[after[after.length - 1].kind], saved: next }
}
