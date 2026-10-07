import type Sigma from 'sigma'
import { useNodeAnchor, type NodeAnchor } from './useNodeAnchor'

/* Issue #85: the playing track, marked on the map whatever is selected or
 * hovered — a soft accent glow around its dot that breathes. A static mark
 * would read as "selected"; the slow pulse reads as "ongoing", the one
 * thing this says.
 *
 * Opacity only (tokens.css's node-halo-pulse), never scale, so reduced
 * motion freezes it on its resting frame rather than hiding it. */

const CLEARANCE_PX = 7

function place(element: HTMLDivElement, { x, y, radiusPx }: NodeAnchor): void {
  const diameter = (radiusPx + CLEARANCE_PX) * 2
  element.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px)`
  element.style.width = `${diameter}px`
  element.style.height = `${diameter}px`
}

export function NodePlayingHalo({ renderer, nodeKey }: { renderer: Sigma | null; nodeKey: string }) {
  const ref = useNodeAnchor(renderer, nodeKey, place)
  return (
    <div
      ref={ref}
      aria-hidden="true"
      className="pointer-events-none absolute top-0 left-0 animate-[node-halo-pulse_var(--motion-pulse)_var(--ease-inout)_infinite] rounded-full shadow-[0_0_14px_4px_color-mix(in_srgb,var(--color-accent)_55%,transparent)]"
    />
  )
}
