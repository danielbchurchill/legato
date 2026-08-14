import type { ReactNode } from 'react'
import { Surface } from './Surface'

/* A floating collection/now-playing panel: glass, a centered muted header, and
 * a scrolling body underneath it.
 *
 * Geometry comes from DESIGN.md's measured layout — 360 wide, inset 51px from
 * the window edge, 59px below the titlebar and 60px above the window's bottom.
 * Height is expressed as top/bottom insets rather than a fixed 844px so the
 * panels grow with the window instead of clipping on a shorter screen. */

const SIDE_CLASSES = {
  left: 'left-[51px]',
  right: 'right-[51px]',
} as const

type PanelProps = {
  side: keyof typeof SIDE_CLASSES
  /** Section header, e.g. "collection". Rubik, muted, centered. */
  title: string
  children?: ReactNode
}

export function Panel({ side, title, children }: PanelProps) {
  return (
    <Surface
      className={`absolute top-[59px] bottom-[60px] w-[360px] ${SIDE_CLASSES[side]} flex flex-col overflow-hidden`}
    >
      <h2 className="shrink-0 pt-[21px] pb-[10px] text-center text-[length:var(--text-base)] font-normal text-[var(--color-muted)]">
        {title}
      </h2>
      {/* min-h-0 so the flex child can actually shrink and scroll rather than
       * pushing the panel past its bounds. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-[var(--spacing-panel)] pb-[var(--spacing-panel)]">
        {children}
      </div>
    </Surface>
  )
}
