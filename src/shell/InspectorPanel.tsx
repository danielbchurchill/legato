import type { ReactNode } from 'react'
import { Surface } from './Surface'
import type { RailDestination } from './rail'

/* v2's Inspector Panel — the 300px column next to the rail. 'search' (the
 * adapted CollectionPanel, passed in as `children`), 'graph' (Music Map
 * settings, `graphContent`), 'settings' (Legato settings, `settingsContent`),
 * 'tags' (Tag Manager, `tagsContent`), 'database' (Database Inspector,
 * `databaseContent`) and 'favourites' (Favourites, `favouritesContent`) all
 * have real content now — every rail destination is filled in, so
 * PLACEHOLDER_LABEL is kept only for whichever one falls through with no
 * content prop supplied (shouldn't happen once App.tsx wires all six, but
 * costs nothing to leave as a fallback). */

const PLACEHOLDER_LABEL: Partial<Record<RailDestination, string>> = {}

type InspectorPanelProps = {
  active: RailDestination
  children?: ReactNode
  graphContent?: ReactNode
  settingsContent?: ReactNode
  tagsContent?: ReactNode
  databaseContent?: ReactNode
  favouritesContent?: ReactNode
}

export function InspectorPanel({
  active,
  children,
  graphContent,
  settingsContent,
  tagsContent,
  databaseContent,
  favouritesContent,
}: InspectorPanelProps) {
  const content =
    active === 'search'
      ? children
      : active === 'graph' && graphContent != null
        ? graphContent
        : active === 'settings' && settingsContent != null
          ? settingsContent
          : active === 'tags' && tagsContent != null
            ? tagsContent
            : active === 'database' && databaseContent != null
              ? databaseContent
              : active === 'favourites' && favouritesContent != null
                ? favouritesContent
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
