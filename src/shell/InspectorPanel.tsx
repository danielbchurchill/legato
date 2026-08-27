import type { ReactNode } from 'react'
import { Surface } from './Surface'
import type { RailDestination } from './rail'

/* v2's Inspector Panel — the 300px column next to the rail. Only 'search'
 * has real content (the adapted CollectionPanel, passed in as `children`);
 * the other five destinations have no defined content in the Figma file at
 * all yet, so they get the app's standard empty-state treatment (DESIGN.md
 * "Empty and error states") naming what's coming instead. */

const PLACEHOLDER_LABEL: Partial<Record<RailDestination, string>> = {
  graph: 'music map settings — coming soon',
  database: 'database inspector — coming soon',
  favourites: 'favourites — coming soon',
  tags: 'tag manager — coming soon',
  settings: 'legato settings — coming soon',
}

type InspectorPanelProps = {
  active: RailDestination
  children?: ReactNode
}

export function InspectorPanel({ active, children }: InspectorPanelProps) {
  return (
    <Surface
      edges="right"
      className="absolute top-[var(--header-height)] bottom-0 left-[var(--rail-width)] z-10 flex w-[var(--panel-width)] flex-col overflow-hidden"
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-[var(--spacing-panel)] pt-[21px] pb-[var(--spacing-panel)]">
        {active === 'search' ? (
          children
        ) : (
          <p className="pt-[40px] text-center text-[length:var(--text-base)] text-[var(--color-muted)]">
            {PLACEHOLDER_LABEL[active]}
          </p>
        )}
      </div>
    </Surface>
  )
}
