import logoSrc from '../assets/brand/white-logo.png'
import { Icon } from '../ui/Icon'
import { Tooltip } from '../ui/Tooltip'
import { Surface } from './Surface'

/* v2's left header: docked to the top-left corner, matching the rail +
 * Inspector Panel's combined width below it. Same position and size
 * whether that panel is expanded or collapsed (DESIGN.md "Panel collapsed
 * (v2)"), but unlike the position, the glass itself is NOT unaffected: the
 * Figma frame draws this header with no fill or border at all once
 * collapsed — bare wordmark and icon floating directly on the canvas, the
 * same treatment the rail already gets. Confirmed against a close crop of
 * the "Panel Collapse" frame's header (node 55:203).
 *
 * The two states also lay out differently, not just re-skin the same slot:
 * expanded keeps the collapse icon docked to the panel's far (right) edge,
 * where it always has been; collapsed packs the expand icon right next to
 * the wordmark with a 10px gap, per the Figma frame's own `gap-[10px]` row
 * (node 55:204) — the rest of the header stays a plain drag region either
 * way. Same glyph both times, rotated the opposite way (nodes 66:85 for the
 * collapsed icon vs. the pre-existing expanded one). */

type LeftPanelHeaderProps = {
  expanded: boolean
  onCollapse: () => void
  onExpand: () => void
}

const GEOMETRY = 'absolute top-0 left-0 z-10 flex h-[var(--header-height)] w-[calc(var(--rail-width)+var(--panel-width))] items-center p-[10px]'

const logomark = (
  <img
    src={logoSrc}
    alt="legato"
    className="pointer-events-none h-[var(--logo-header)] w-[var(--logo-header)] select-none"
  />
)

export function LeftPanelHeader({ expanded, onCollapse, onExpand }: LeftPanelHeaderProps) {
  const content = expanded ? (
    <>
      {/* The drag region is whatever space isn't a button — same approach
       * the old single titlebar used. */}
      <div data-tauri-drag-region className="flex h-full flex-1 items-center justify-between">
        {logomark}
        <Tooltip label="Collapse panel">
          <button
            type="button"
            onClick={onCollapse}
            aria-label="Collapse panel"
            className="inline-flex items-center justify-center text-[var(--color-muted)] transition-colors duration-[var(--motion-fast)] hover:text-[var(--color-muted-hi)]"
          >
            <Icon name="panel-left-collapse" size={24} />
          </button>
        </Tooltip>
      </div>
    </>
  ) : (
    <>
      <div className="flex h-full shrink-0 items-center gap-[10px]">
        {logomark}
        <Tooltip label="Expand panel">
          <button
            type="button"
            onClick={onExpand}
            aria-label="Expand panel"
            className="inline-flex items-center justify-center text-[var(--color-muted)] transition-colors duration-[var(--motion-fast)] hover:text-[var(--color-muted-hi)]"
          >
            <span className="inline-flex rotate-180">
              <Icon name="panel-left-collapse" size={24} />
            </span>
          </button>
        </Tooltip>
      </div>
      <div data-tauri-drag-region className="h-full flex-1" />
    </>
  )

  if (expanded) {
    return (
      <Surface edges="bottom-right" className={GEOMETRY}>
        {content}
      </Surface>
    )
  }

  return <div className={GEOMETRY}>{content}</div>
}
