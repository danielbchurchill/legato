import type { ReactNode } from 'react'
import { Surface } from './Surface'
import type { RailDestination } from './rail'

/* v2's Inspector Panel — the 300px column next to the rail. 'search' (the
 * adapted CollectionPanel, passed in as `children`), 'graph' (Music Map
 * settings, `graphContent`) and 'settings' (Legato settings,
 * `settingsContent`) have real content; the other three destinations have no
 * defined content in the Figma file at all yet, so they get the app's
 * standard empty-state treatment (DESIGN.md "Empty and error states") naming
 * what's coming instead. */

const PLACEHOLDER_LABEL: Partial<Record<RailDestination, string>> = {
  database: 'database inspector — coming soon',
  favourites: 'favourites — coming soon',
  tags: 'tag manager — coming soon',
}

type InspectorPanelProps = {
  active: RailDestination
  children?: ReactNode
  graphContent?: ReactNode
  settingsContent?: ReactNode
}

export function InspectorPanel({ active, children, graphContent, settingsContent }: InspectorPanelProps) {
  const content =
    active === 'search'
      ? children
      : active === 'graph' && graphContent != null
        ? graphContent
        : active === 'settings' && settingsContent != null
          ? settingsContent
          : undefined

  return (
    <Surface
      edges="right"
      className="absolute top-[var(--header-height)] bottom-0 left-[var(--rail-width)] z-10 flex w-[var(--panel-width)] flex-col overflow-hidden"
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-[var(--spacing-panel)] pt-[21px] pb-[var(--spacing-panel)]">
        {content ?? (
          <p className="pt-[40px] text-center text-[length:var(--text-base)] text-[var(--color-muted)]">
            {PLACEHOLDER_LABEL[active]}
          </p>
        )}
      </div>
    </Surface>
  )
}
