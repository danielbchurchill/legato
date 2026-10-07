import type Sigma from 'sigma'
import { useNodeAnchor, type NodeAnchor } from './useNodeAnchor'

/* The selected node's ring: a 2px solid accent circle, 8px in radius, or a
 * little more than the dot when zoom has grown the dot past that. DOM rather
 * than sigma's hover layer, which drag also draws through. */

const RING_RADIUS_PX = 8
const MIN_CLEARANCE_PX = 3

function place(element: HTMLDivElement, { x, y, radiusPx }: NodeAnchor): void {
  const radius = Math.max(RING_RADIUS_PX, radiusPx + MIN_CLEARANCE_PX)
  element.style.transform = `translate(${x - radius}px, ${y - radius}px)`
  element.style.width = `${radius * 2}px`
  element.style.height = `${radius * 2}px`
}

export function SelectionRing({ renderer, nodeKey }: { renderer: Sigma | null; nodeKey: string }) {
  const ref = useNodeAnchor(renderer, nodeKey, place)
  return (
    <div
      ref={ref}
      aria-hidden="true"
      className="pointer-events-none absolute top-0 left-0 rounded-full border-2 border-[var(--color-accent)]"
    />
  )
}
