import type { ReactNode } from 'react'
import { Surface } from './Surface'
import { PanelResizeHandle } from './PanelResizeHandle'

/* A floating collection/now-playing panel: glass, a centered muted header, and
 * a scrolling body underneath it.
 *
 * Geometry comes from DESIGN.md's measured layout — 360 wide, inset 51px from
 * the window edge, 59px below the titlebar and 60px above the window's bottom.
 * Height is expressed as top/bottom insets rather than a fixed 844px so the
 * panels grow with the window instead of clipping on a shorter screen.
 *
 * P-8: side inset is a token (--panel-inset in tokens.css), scaling with the
 * window above the 1440px reference. Width used to be a token the same way,
 * but panels are now independently resizable by dragging their own inner
 * edge — App.tsx owns the resolved px width (P-8 default or a drag
 * override) and passes it in explicitly, the same number it hands Canvas.tsx
 * for G-8's free-canvas math, so the two stay in lockstep. */

const SIDE_CLASSES = {
  left: 'left-[var(--panel-inset)]',
  right: 'right-[var(--panel-inset)]',
} as const

type PanelProps = {
  side: keyof typeof SIDE_CLASSES
  /** Section header, e.g. "collection". Rubik, muted, centered. */
  title: string
  children?: ReactNode
  widthPx: number
  minWidthPx: number
  maxWidthPx: number
  onWidthChange: (widthPx: number) => void
  onWidthCommit: (widthPx: number) => void
}

export function Panel({ side, title, children, widthPx, minWidthPx, maxWidthPx, onWidthChange, onWidthCommit }: PanelProps) {
  return (
    <Surface
      className={`absolute top-[59px] bottom-[60px] ${SIDE_CLASSES[side]} flex flex-col overflow-hidden`}
      style={{ width: widthPx }}
    >
      <h2 className="shrink-0 pt-[21px] pb-[10px] text-center text-[length:var(--text-base)] font-normal text-[var(--color-muted)]">
        {title}
      </h2>
      {/* min-h-0 so the flex child can actually shrink and scroll rather than
       * pushing the panel past its bounds. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-[var(--spacing-panel)] pb-[var(--spacing-panel)]">
        {children}
      </div>
      <PanelResizeHandle
        side={side}
        widthPx={widthPx}
        minPx={minWidthPx}
        maxPx={maxWidthPx}
        onChange={onWidthChange}
        onCommit={onWidthCommit}
      />
    </Surface>
  )
}
