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
 * addition to close that gap, not a measured value.
 *
 * #57: `expanded` is no longer purely a manual toggle — App.tsx forces it
 * false whenever nothing is loaded (collapsedNodeId null), auto-collapsing
 * the panel instead of leaving it open on NowPlayingPanel's old "nothing
 * playing" text. That idle case gets its own branch below rather than
 * reusing the click-to-expand button: there's nothing queued to expand
 * into, so the collapsed content's own quick-play button (NowPlayingCollapsed)
 * is the only affordance, and it can't sit inside another <button> (invalid
 * HTML — the outer element would swallow its clicks). */

const COLLAPSED_GEOMETRY =
  // grid, not the no-display-utility default: a native <button>'s content is
  // vertically centered by the browser's own internal layout for the element
  // regardless of what `display` an author sets (block, in this case, from
  // being blockified by `position: absolute`) — confirmed by measuring this
  // exact button in a real browser, not just reading the class list. `grid`
  // is the one display value that opts back out of that built-in centering,
  // so the cover + track block actually lands at pt-24 below the header
  // instead of floating in the middle of the collapsed column. grid-cols-1
  // has to come with it: an implicit grid track sizes itself to its
  // content's max-content width by default, which is exactly wide enough for
  // NowPlayingCollapsed's un-hovered, nowrap'd title text to blow straight
  // past this column's actual 194px and off the edge of the window —
  // minmax(0,1fr) (what grid-cols-1 actually generates) is what makes the
  // column cap at the available width the way a plain block child always
  // would.
  'absolute top-[var(--header-height)] right-0 bottom-0 z-10 grid w-[var(--panel-width-collapsed)] grid-cols-1 items-start overflow-y-auto px-[var(--spacing-sm)] pt-[24px] text-left'

type RightPanelProps = {
  expanded: boolean
  collapsedNodeId: number | null
  onExpand: () => void
  onQuickPlay: () => void
  children: ReactNode
}

export function RightPanel({ expanded, collapsedNodeId, onExpand, onQuickPlay, children }: RightPanelProps) {
  if (!expanded) {
    if (collapsedNodeId == null) {
      return (
        <div className={COLLAPSED_GEOMETRY}>
          <NowPlayingCollapsed nodeId={null} onQuickPlay={onQuickPlay} />
        </div>
      )
    }

    return (
      <button type="button" onClick={onExpand} aria-label="Expand now playing" className={COLLAPSED_GEOMETRY}>
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
