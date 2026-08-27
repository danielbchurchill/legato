import type Sigma from 'sigma'
import { Surface } from '../shell/Surface'
import { useMountFade } from '../ui/useMountFade'
import { useNodeAnchor, type NodeAnchor } from './useNodeAnchor'

/* Figma frame 31:247 ("Hovered"). A glass plate naming the node under the
 * pointer, tucked under its bottom edge.
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
const TEXT_INSET_PX = 15 // node's bottom edge to the *glass surface's* top edge

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
      <Surface
        // px/pb are from the frame. pt matches pb rather than the frame's own
        // (unequal) figure — the frame's padding-top included the portion of
        // the box meant to sit behind the node, but the wrapper's own
        // padding-top (place(), above) already accounts for that separately;
        // this is purely the surface's internal text inset, and it reads
        // as lopsided if it doesn't match the bottom.
        className="flex max-w-[280px] flex-col items-center gap-[9px] px-[15px] py-[17px] transition-opacity duration-[var(--motion-fast)] ease-[var(--ease-out)]"
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
      </Surface>
    </div>
  )
}
