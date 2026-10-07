import type Sigma from 'sigma'
import { useMountFade } from '../ui/useMountFade'
import { useNodeAnchor, type NodeAnchor } from './useNodeAnchor'

/* Hover: a small glass label under the node, naming it — the title over its
 * artist. Most dots on the map carry no label of their own (only artists and
 * credits do), so this is how a track or a record says what it is. It rides
 * the same dwell as the hover focus, so one gesture gets one response. */

const GAP_PX = 8

function place(element: HTMLDivElement, { x, y, radiusPx }: NodeAnchor): void {
  element.style.transform = `translate(-50%, 0) translate(${x}px, ${y + radiusPx + GAP_PX}px)`
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
      <div
        className="glass flex max-w-[280px] flex-col rounded-[var(--radius-control)] px-[10px] py-[6px] shadow-[var(--shadow-sm)] transition-opacity duration-[var(--motion-fast)] ease-[var(--ease-out)]"
        style={{ opacity: shown ? 1 : 0 }}
      >
        <span className="truncate text-[length:var(--text-secondary)] leading-[18px] font-medium text-[var(--color-ink)]">{title}</span>
        {subtitle && <span className="truncate text-small text-[var(--color-ink-2)]">{subtitle}</span>}
      </div>
    </div>
  )
}
