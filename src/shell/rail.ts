import type { IconName } from '../ui/Icon'

/* The left icon rail's destinations, in order. Figma's "Inspector Control"
 * frame — see DESIGN.md's shell section — named six; 'playlists' is a
 * seventh added ahead of Figma catching up, same footing as
 * database/favourites/tags before it (see Icon.tsx's own note on those).
 * Every destination here has real content behind it now. */

export type RailDestination = 'search' | 'graph' | 'database' | 'favourites' | 'playlists' | 'tags' | 'settings'

export const RAIL_ITEMS: { id: RailDestination; icon: IconName; label: string }[] = [
  { id: 'search', icon: 'search', label: 'Search' },
  { id: 'graph', icon: 'map', label: 'Music Map' },
  { id: 'database', icon: 'database', label: 'Database Inspector' },
  { id: 'favourites', icon: 'heart', label: 'Favourites' },
  { id: 'playlists', icon: 'list', label: 'Playlists' },
  { id: 'tags', icon: 'tag', label: 'Tag Manager' },
  { id: 'settings', icon: 'sliders', label: 'Legato Settings' },
]
