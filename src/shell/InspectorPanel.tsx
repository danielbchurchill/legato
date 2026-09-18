import type { ReactNode } from 'react'
import { Surface } from './Surface'
import type { RailDestination } from './rail'

/* v2's Inspector Panel — the 300px column next to the rail. 'search' (the
 * adapted CollectionPanel, passed in as `children`), 'graph' (Music Map
 * settings, `graphContent`), 'settings' (Legato settings, `settingsContent`),
 * 'tags' (Tag Manager, `tagsContent`), 'database' (Database Inspector,
 * `databaseContent`), 'favourites' (Favourites, `favouritesContent`) and
 * 'playlists' (Playlists, `playlistsContent`) all have real content now —
 * every rail destination is filled in, so PLACEHOLDER_LABEL is kept only for
 * whichever one falls through with no content prop supplied (shouldn't
 * happen once App.tsx wires all seven, but costs nothing to leave as a
 * fallback). */

const PLACEHOLDER_LABEL: Partial<Record<RailDestination, string>> = {}

// The panel title, in the same lowercase Rubik-muted voice as every
// SectionHeader and RightPanel's own "now playing" — not RAIL_ITEMS' Title
// Case tooltip labels, though the words themselves now agree ('graph' ->
// "Music Map" tooltip, 'music map' title) same as every other destination.
const TITLES: Record<RailDestination, string> = {
  search: 'search',
  graph: 'music map',
  database: 'database inspector',
  favourites: 'favourites',
  playlists: 'playlists',
  tags: 'tag manager',
  settings: 'settings',
}

type InspectorPanelProps = {
  active: RailDestination
  children?: ReactNode
  graphContent?: ReactNode
  settingsContent?: ReactNode
  tagsContent?: ReactNode
  databaseContent?: ReactNode
  favouritesContent?: ReactNode
  playlistsContent?: ReactNode
}

export function InspectorPanel({
  active,
  children,
  graphContent,
  settingsContent,
  tagsContent,
  databaseContent,
  favouritesContent,
  playlistsContent,
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
                : active === 'playlists' && playlistsContent != null
                  ? playlistsContent
                  : undefined

  return (
    <Surface
      edges="right"
      className="absolute top-[var(--header-height)] bottom-0 left-[var(--rail-width)] z-10 flex w-[var(--panel-width)] flex-col overflow-hidden"
    >
      <h2 className="shrink-0 pt-[21px] pb-[10px] text-center text-[length:var(--text-base)] font-normal text-[var(--color-muted)]">
        {TITLES[active]}
      </h2>
      {/* overflow-x-hidden is load-bearing, not decorative: `overflow-y-auto`
       * alone computes to `overflow-x: auto` too (CSS upgrades a lone
       * 'visible' axis to 'auto' the moment its sibling axis isn't), so any
       * child that ever manages to spill past this single narrow column
       * would surface as a real horizontal scrollbar here — issue #86 — on
       * a panel every one of these rail destinations shares one instance
       * of. Pinning x closed is what makes "never a scrollbar" actually
       * true rather than "true until the next panel content someone adds
       * doesn't wrap or truncate correctly." */}
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-[var(--spacing-panel)] pb-[var(--spacing-panel)]">
        {content ?? (
          <p className="pt-[40px] text-center text-[length:var(--text-base)] text-[var(--color-muted)]">
            {PLACEHOLDER_LABEL[active]}
          </p>
        )}
      </div>
    </Surface>
  )
}
