import type { CSSProperties, ReactNode } from 'react'

/* The one glass recipe every raised surface in the app shares. See DESIGN.md
 * "Glass" — panels, the toggle pill, the titlebar and the transport dock are
 * all this, differing only in which edges and corners they keep.
 *
 * Blur is load-bearing here, not decoration: the graph running underneath the
 * panels is the whole concept, so these never become opaque. If backdrop-filter
 * has to be dropped for performance, it degrades to --color-surface-flat, which
 * is the same perceived color without the compositing cost. */

export type SurfaceEdges = 'all' | 'bottom' | 'top-dock' | 'right' | 'left' | 'bottom-right' | 'bottom-left'

const EDGE_CLASSES: Record<SurfaceEdges, string> = {
  // A floating panel: every edge, fully rounded.
  all: 'rounded-[var(--radius-surface)] border',
  // The titlebar: spans the window, so only its inner edge is real.
  bottom: 'border-b',
  // The transport: docked to the window's bottom edge, so its bottom border
  // and bottom corners would sit outside the window.
  'top-dock':
    'rounded-t-[var(--radius-surface)] border-t border-l border-r',
  // v2's rail and left Inspector Panel: docked flush to the window's left
  // edge and full height, so only the inner (right) edge is real — no
  // radius, same reasoning as the titlebar spanning the window.
  right: 'border-r',
  // v2's right (now-playing) panel: the mirror image, docked flush right.
  left: 'border-l',
  // v2's Left Panel Header: docked to the top-left corner.
  'bottom-right': 'border-b border-r',
  // v2's Right Panel Header: docked to the top-right corner.
  'bottom-left': 'border-b border-l',
}

type SurfaceProps = {
  children?: ReactNode
  edges?: SurfaceEdges
  className?: string
  style?: CSSProperties
}

export function Surface({ children, edges = 'all', className = '', style }: SurfaceProps) {
  return (
    <div
      className={`border-[var(--color-hairline)] bg-[var(--color-surface)] backdrop-blur-[var(--blur-glass)] shadow-[var(--shadow-surface)] ${EDGE_CLASSES[edges]} ${className}`}
      style={style}
    >
      {children}
    </div>
  )
}
