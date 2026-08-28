import type { ReactNode } from 'react'
import { Surface } from './Surface'
import { NowPlayingCollapsed } from '../panels/NowPlayingCollapsed'

/* v2's right (now-playing) panel body. Docked flush to the window's right
 * edge, full height below RightPanelHeader.
 *
 * Collapsing removes the glass entirely rather than shrinking it (DESIGN.md
 * "Panel collapsed (v2)") — the two branches below aren't the same surface
 * at two widths, they're a real glass panel versus plain content floating
 * on the canvas, same as the rail-only collapsed left side.
 *
 * DESIGN.md's collapsed section notes there is no dedicated "expand"
 * affordance for the right side in the Figma frames at all, only a collapse
 * one — a real dead end as specified, since nothing else in this app leaves
 * a state with no way back. `onExpand` on the collapsed content itself
 * (click the cover/track block to bring the panel back) is this file's own
 * addition to close that gap, not a measured value. */

type RightPanelProps = {
  expanded: boolean
  collapsedNodeId: number | null
  onExpand: () => void
  children: ReactNode
}

export function RightPanel({ expanded, collapsedNodeId, onExpand, children }: RightPanelProps) {
  if (!expanded) {
    return (
      <button
        type="button"
        onClick={onExpand}
        aria-label="Expand now playing"
        className="absolute top-[var(--header-height)] right-0 bottom-0 z-10 w-[var(--panel-width-collapsed)] overflow-y-auto px-[var(--spacing-sm)] pt-[24px] text-left"
      >
        <NowPlayingCollapsed nodeId={collapsedNodeId} />
      </button>
    )
  }

  return (
    <Surface
      edges="left"
      className="absolute top-[var(--header-height)] right-0 bottom-0 z-10 flex w-[var(--panel-width)] flex-col overflow-hidden"
    >
      <h2 className="shrink-0 pt-[21px] pb-[10px] text-center text-[length:var(--text-base)] font-normal text-[var(--color-muted)]">
        now playing
      </h2>
      <div className="min-h-0 flex-1 overflow-y-auto px-[var(--spacing-panel)] pb-[var(--spacing-panel)]">
        {children}
      </div>
    </Surface>
  )
}
