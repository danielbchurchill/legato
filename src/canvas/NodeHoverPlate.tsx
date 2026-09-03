import type Sigma from 'sigma'
import { useMountFade } from '../ui/useMountFade'
import { useNodeAnchor, type NodeAnchor } from './useNodeAnchor'

/* Figma frame 31:247 ("Hovered"). A label naming the node under the pointer,
 * tucked under its bottom edge.
 *
 * The frame draws this as a glass plate; #27 dropped the glass deliberately —
 * against the canvas's own busy, colorful cover art, a translucent box around
 * two lines of text read as visual clutter rather than as wayfinding, and
 * plain text sitting a little closer to the node reads as a label for it
 * instead of a small panel of its own. This is the one deviation from the
 * frame in this file; everything else (dwell timing, the addition-not-
 * substitution rule, the mono/ink type treatment) is unchanged.
 *
 * The frame draws the plate against a 255px cover. That cover is the node
 * itself, drawn for context — the plate is the only thing hover adds, which
 * keeps hover on the right side of DESIGN.md's "an addition, never a
 * substitution" rule and means the plate works at any zoom rather than only
 * at the one the frame happens to be drawn at.
 *
 * Both lines are Sometype Mono in --color-ink, and that is not a violation of
 * the Rubik-names-it / mono-is-it rule: a title and an artist are both data.
 * There is no label here to be muted. */

// Measured from the frame: a 159 x 102 plate at 48,232 against a 255px cover.
// Only the relationships survive as constants — the plate's own width is
// whatever its title measures, and 159 is simply what "MATRIARCHY NOW" came
// out at.
const OVERLAP_PX = 23 // how far the plate's top edge tucks behind the node
const OVERLAP_RATIO = 0.09 // 23 / 255, so a small node isn't swallowed
// The frame's ratio was measured against a near-selected, 255px-wide node.
// Hover fires at any zoom, and the graph's default whole-library view
// renders nodes far smaller than that (a ~22px radius at camera ratio 1,
// often less) — 9% of that diameter rounds to a 3-4px tuck, which reads as
// the plate sitting adjacent to the node rather than attached to it. This
// floors the tuck so it stays legible at typical zoom, itself capped at the
// node's own radius so it still can't swallow a genuinely tiny node.
const OVERLAP_MIN_PX = 10
// #27: node's bottom edge to the label's own top edge — was 15 (the frame's
// figure for the *glass surface's* top edge); tightened now that there's no
// glass box to give the gap visual weight of its own, so the same 15px read
// as more distance than it did with a bordered plate to anchor it.
const TEXT_INSET_PX = 6

function place(element: HTMLDivElement, { x, y, radiusPx }: NodeAnchor): void {
  const overlap = Math.min(OVERLAP_PX, Math.max(Math.min(OVERLAP_MIN_PX, radiusPx), radiusPx * 2 * OVERLAP_RATIO))
  // This padding-top lands on the wrapper `element`, not on the visible
  // glass Surface nested inside it — the wrapper has no border or
  // background, so this only ever decides where the *box itself* lands
  // (it pushes the Surface down within the wrapper by exactly as much as
  // the wrapper's own top was pulled up, landing the box TEXT_INSET_PX
  // below the node regardless of overlap). It was never meant to be, and
  // must not become, the surface's own internal top padding — that's a
  // separate, fixed py-[17px] on the Surface itself below, symmetric on
  // purpose.
  element.style.transform = `translate(-50%, 0) translate(${x}px, ${y + radiusPx - overlap}px)`
  element.style.paddingTop = `${overlap + TEXT_INSET_PX}px`
}

type NodeHoverPlateProps = {
  renderer: Sigma | null
  nodeKey: string
  title: string
  subtitle: string | null
}

export function NodeHoverPlate({ renderer, nodeKey, title, subtitle }: NodeHoverPlateProps) {
  const ref = useNodeAnchor(renderer, nodeKey, place)
  const shown = useMountFade()

  return (
    <div ref={ref} className="pointer-events-none absolute top-0 left-0">
      {/* #27: no glass here — see the module comment. Just the two lines,
       * centred under the node, close enough that they read as this node's
       * own label rather than a panel floating near it. */}
      <div
        className="flex max-w-[280px] flex-col items-center gap-[9px] transition-opacity duration-[var(--motion-fast)] ease-[var(--ease-out)]"
        style={{ opacity: shown ? 1 : 0 }}
      >
        <p className="max-w-full truncate text-center font-[family-name:var(--font-mono)] text-[length:var(--text-base)] leading-[19px] text-[var(--color-ink)]">
          {title}
        </p>
        {/* Artist nodes have no second line — the plate is one line tall and
         * that is the whole state, not a missing value needing a placeholder. */}
        {subtitle && (
          <p className="max-w-full truncate text-center font-[family-name:var(--font-mono)] text-[length:var(--text-base)] leading-[19px] text-[var(--color-ink)]">
            {subtitle}
          </p>
        )}
      </div>
    </div>
  )
}
