import { Icon } from '../ui/Icon'
import { Tooltip } from '../ui/Tooltip'
import { Surface } from './Surface'
import { RAIL_ITEMS, type RailDestination } from './rail'

/* v2's left icon rail — "Inspector Control" in the Figma file. Docked flush
 * to the window's left edge, full height below LeftPanelHeader; present
 * whether or not the adjacent Inspector Panel is expanded (only the panel
 * itself, not the rail, disappears when the left side is collapsed). */

type InspectorRailProps = {
  active: RailDestination | null
  onSelect: (id: RailDestination) => void
}

export function InspectorRail({ active, onSelect }: InspectorRailProps) {
  return (
    <Surface
      edges="right"
      className="absolute top-[var(--header-height)] bottom-0 left-0 z-10 flex w-[var(--rail-width)] flex-col items-center gap-[var(--spacing-lg)] pt-[10px]"
    >
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
    </Surface>
  )
}
