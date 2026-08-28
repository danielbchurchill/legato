import { Icon } from '../ui/Icon'
import { Tooltip } from '../ui/Tooltip'
import { Surface } from './Surface'

/* v2's left header: docked to the top-left corner, matching the rail +
 * Inspector Panel's combined width below it. Same position and size
 * whether that panel is expanded or collapsed (DESIGN.md "Panel collapsed
 * (v2)") — only its own contents change: the collapse icon disappears once
 * the panel already is. */

type LeftPanelHeaderProps = {
  expanded: boolean
  onCollapse: () => void
}

export function LeftPanelHeader({ expanded, onCollapse }: LeftPanelHeaderProps) {
  return (
    <Surface
      edges="bottom-right"
      className="absolute top-0 left-0 z-10 flex h-[var(--header-height)] w-[calc(var(--rail-width)+var(--panel-width))] items-center justify-between p-[10px]"
    >
      {/* The drag region is whatever space isn't a button — same approach
       * the old single titlebar used. */}
      <div data-tauri-drag-region className="flex h-full flex-1 items-center">
        <span className="pointer-events-none select-none font-[family-name:var(--font-display)] text-[length:var(--text-wordmark-header)] leading-none text-[var(--color-ink)]">
          legato
        </span>
      </div>
      {expanded && (
        <Tooltip label="Collapse panel">
          <button
            type="button"
            onClick={onCollapse}
            aria-label="Collapse panel"
            className="text-[var(--color-muted)] transition-colors duration-[var(--motion-fast)] hover:text-[var(--color-muted-hi)]"
          >
            <Icon name="panel-left-collapse" size={24} />
          </button>
        </Tooltip>
      )}
    </Surface>
  )
}
