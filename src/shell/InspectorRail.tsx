import { Icon } from '../ui/Icon'
import { Tooltip } from '../ui/Tooltip'
import { TooltipGroup } from '../ui/TooltipGroup'
import { Surface } from './Surface'
import { RAIL_ITEMS, type RailDestination } from './rail'

/* v2's left icon rail — "Inspector Control" in the Figma file. Docked flush
 * to the window's left edge, full height below LeftPanelHeader; present
 * whether or not the adjacent Inspector Panel is expanded (only the panel
 * itself, not the rail, disappears when the left side is collapsed). Its
 * own glass follows the panel's state though: with a panel open next to it,
 * the rail's right border reads as that panel's left edge (Surface
 * `edges="right"`); with no panel there, DESIGN.md's "Panel collapsed (v2)"
 * calls for the six icons floating bare on the canvas, no fill or border —
 * confirmed against the "Panel Collapse" frame, same as both headers. */

type InspectorRailProps = {
  active: RailDestination | null
  onSelect: (id: RailDestination) => void
}

const GEOMETRY =
  'absolute top-[var(--header-height)] bottom-0 left-0 z-10 flex w-[var(--rail-width)] flex-col items-center gap-[var(--spacing-lg)] pt-[10px]'

export function InspectorRail({ active, onSelect }: InspectorRailProps) {
  // TooltipGroup: the six icons are the one real row of adjacent tooltip
  // triggers in the app today — wrapping them lets a sweep across the rail
  // read as one continuous tooltip instead of six independent 400ms dwells.
  const icons = (
    <TooltipGroup>
      {RAIL_ITEMS.map((item) => {
        const isActive = item.id === active
        return (
          <Tooltip key={item.id} label={item.label}>
            <button
              type="button"
              onClick={() => onSelect(item.id)}
              aria-label={item.label}
              aria-pressed={isActive}
              className={`transition-colors duration-[var(--motion-fast)] ${
                isActive ? 'text-[var(--color-ink)]' : 'text-[var(--color-muted)] hover:text-[var(--color-muted-hi)]'
              }`}
            >
              <Icon name={item.icon} size={24} />
            </button>
          </Tooltip>
        )
      })}
    </TooltipGroup>
  )

  if (active != null) {
    return (
      <Surface edges="right" className={GEOMETRY}>
        {icons}
      </Surface>
    )
  }

  return <div className={GEOMETRY}>{icons}</div>
}
