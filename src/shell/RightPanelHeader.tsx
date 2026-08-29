import { Icon } from '../ui/Icon'
import { Tooltip } from '../ui/Tooltip'
import { Surface } from './Surface'

/* v2's right header: docked to the top-right corner, matching the
 * now-playing panel's width below it, unaffected by that panel's own
 * collapse state (DESIGN.md "Panel collapsed (v2)") the same way
 * LeftPanelHeader is. The avatar chip is a static settings-access affordance
 * for a single-user desktop app — there is no real account state to wire it
 * to, so it stays a plain "DC" chip.
 *
 * The window now runs with native OS decorations (tauri.conf.json's
 * `decorations: true`) instead of the frameless custom minimize/maximize/
 * close cluster this header used to render (WindowControls.tsx, since
 * removed) — each platform's own titlebar and chrome apply instead. */

type RightPanelHeaderProps = {
  expanded: boolean
  onCollapse: () => void
}

export function RightPanelHeader({ expanded, onCollapse }: RightPanelHeaderProps) {
  return (
    <Surface
      edges="bottom-left"
      className="absolute top-0 right-0 z-10 flex h-[var(--header-height)] w-[var(--panel-width)] items-center justify-between p-[10px]"
    >
      <div data-tauri-drag-region className="flex h-full flex-1 items-center">
        {expanded && (
          <Tooltip label="Collapse panel">
            <button
              type="button"
              onClick={onCollapse}
              aria-label="Collapse panel"
              className="text-[var(--color-muted)] transition-colors duration-[var(--motion-fast)] hover:text-[var(--color-muted-hi)]"
            >
              {/* Same glyph as the left header's collapse icon, rotated —
               * confirmed in the Figma file, not a separate asset. */}
              <span className="inline-flex rotate-180">
                <Icon name="panel-left-collapse" size={24} />
              </span>
            </button>
          </Tooltip>
        )}
      </div>
      <div
        aria-hidden
        className="grid size-[29.5px] shrink-0 place-items-center rounded-full bg-[var(--color-control)] font-[family-name:var(--font-ui)] text-[length:var(--text-sm)] text-[var(--color-ink)]"
      >
        DC
      </div>
    </Surface>
  )
}
