import { Icon } from '../ui/Icon'
import { Surface } from './Surface'

/* The map/library switch (issue #126, D11 — see DESIGN.md "Library view").
 * Same recipe as the retired GraphToggle (a Surface pill, tabs differing by
 * color alone, muted -> ink for the active one): DESIGN.md's active-state
 * rule ("--color-ink ... reserved for values and for genuinely active
 * state") applies here exactly as it did there.
 *
 * Centered under the headers rather than GraphToggle's old fixed 69px (that
 * number was measured against the single continuous titlebar this app no
 * longer has, per AppShell.tsx's v2 note) — --header-height plus one
 * --spacing-lg step clears both LeftPanelHeader and RightPanelHeader
 * regardless of window width, which a fixed pixel wouldn't once the side
 * panels themselves start scaling past the 1440px reference. */

export type ViewMode = 'map' | 'library'

const VIEWS: { id: ViewMode; label: string; icon: 'map' | 'list' }[] = [
  { id: 'map', label: 'map', icon: 'map' },
  { id: 'library', label: 'library', icon: 'list' },
]

type ViewSwitchProps = {
  value: ViewMode
  onChange: (value: ViewMode) => void
}

export function ViewSwitch({ value, onChange }: ViewSwitchProps) {
  return (
    <Surface
      className="absolute top-[calc(var(--header-height)+var(--spacing-lg))] left-1/2 h-[41px] -translate-x-1/2 overflow-hidden"
      style={{ zIndex: 10 }}
    >
      <div role="tablist" className="flex h-full items-center gap-[var(--spacing-lg)] px-[var(--spacing-lg)]">
        {VIEWS.map((view) => {
          const active = view.id === value
          return (
            <button
              key={view.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onChange(view.id)}
              className={`flex items-center gap-[var(--spacing-xs)] text-[length:var(--text-base)] leading-none transition-colors duration-[var(--motion-fast)] ${
                active ? 'text-[var(--color-ink)]' : 'text-[var(--color-muted)] hover:text-[var(--color-muted-hi)]'
              }`}
            >
              <Icon name={view.icon} size={18} />
              {view.label}
            </button>
          )
        })}
      </div>
    </Surface>
  )
}
