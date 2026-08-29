import { Icon } from '../ui/Icon'
import { Tooltip } from '../ui/Tooltip'
import { Surface } from './Surface'

/* v2's right header: docked to the top-right corner, matching the
 * now-playing panel's width below it. Same position and size whether that
 * panel is expanded or collapsed (DESIGN.md "Panel collapsed (v2)"), but
 * the glass itself is NOT unaffected the way the position is: the Figma
 * frame draws this header with no fill or border at all once collapsed —
 * bare icon and avatar floating directly on the canvas. Confirmed against a
 * close crop of the "Panel Collapse" frame's header (node 55:203).
 *
 * The two states also lay out differently, not just re-skin the same slot:
 * expanded docks the collapse icon to the panel's far (left) edge, inside
 * the drag region, well clear of the avatar — that's the pre-existing
 * layout, unchanged. Collapsed groups the expand icon with the avatar at
 * the far right instead, gap-[10px] between them, matching the Figma
 * frame's own "Frame 7" grouping (node 66:84) — there's no rail-icon
 * equivalent to dock the collapsed icon to on this side, so it rides along
 * with the one thing that's always there. The avatar chip is a static
 * settings-access affordance for a single-user desktop app — there is no
 * real account state to wire it to, so it stays a plain "DC" chip in both
 * states.
 *
 * The window now runs with native OS decorations (tauri.conf.json's
 * `decorations: true`) instead of the frameless custom minimize/maximize/
 * close cluster this header used to render (WindowControls.tsx, since
 * removed) — each platform's own titlebar and chrome apply instead. */

type RightPanelHeaderProps = {
  expanded: boolean
  onCollapse: () => void
  onExpand: () => void
}

const GEOMETRY = 'absolute top-0 right-0 z-10 flex h-[var(--header-height)] w-[var(--panel-width)] items-center justify-between p-[10px]'

const avatar = (
  <div
    aria-hidden
    className="grid size-[29.5px] shrink-0 place-items-center rounded-full bg-[var(--color-control)] font-[family-name:var(--font-ui)] text-[length:var(--text-sm)] text-[var(--color-ink)]"
  >
    DC
  </div>
)

export function RightPanelHeader({ expanded, onCollapse, onExpand }: RightPanelHeaderProps) {
  const content = expanded ? (
    <>
      <div data-tauri-drag-region className="flex h-full flex-1 items-center">
        <Tooltip label="Collapse panel">
          <button
            type="button"
            onClick={onCollapse}
            aria-label="Collapse panel"
            className="inline-flex items-center justify-center text-[var(--color-muted)] transition-colors duration-[var(--motion-fast)] hover:text-[var(--color-muted-hi)]"
          >
            {/* Same glyph as the left header's collapse icon, rotated —
             * confirmed in the Figma file, not a separate asset. */}
            <span className="inline-flex rotate-180">
              <Icon name="panel-left-collapse" size={24} />
            </span>
          </button>
        </Tooltip>
      </div>
      {avatar}
    </>
  ) : (
    <>
      <div data-tauri-drag-region className="flex h-full flex-1 items-center" />
      <div className="flex shrink-0 items-center gap-[10px]">
        <Tooltip label="Expand panel">
          <button
            type="button"
            onClick={onExpand}
            aria-label="Expand panel"
            className="inline-flex items-center justify-center text-[var(--color-muted)] transition-colors duration-[var(--motion-fast)] hover:text-[var(--color-muted-hi)]"
          >
            {/* Unrotated — the mirror of the left header's expanded-state
             * icon, matching the collapsed-state glyph in the Figma file. */}
            <Icon name="panel-left-collapse" size={24} />
          </button>
        </Tooltip>
        {avatar}
      </div>
    </>
  )

  if (expanded) {
    return (
      <Surface edges="bottom-left" className={GEOMETRY}>
        {content}
      </Surface>
    )
  }

  return <div className={GEOMETRY}>{content}</div>
}
