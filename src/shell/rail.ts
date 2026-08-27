import type { IconName } from '../ui/Icon'

/* The left icon rail's six destinations, in order. Figma's "Inspector
 * Control" frame — see DESIGN.md's shell section. Only 'search' has real
 * content behind it yet (the adapted CollectionPanel); the rest render a
 * placeholder until their own workstreams land. */

export type RailDestination = 'search' | 'graph' | 'database' | 'favourites' | 'tags' | 'settings'

export const RAIL_ITEMS: { id: RailDestination; icon: IconName; label: string }[] = [
  { id: 'search', icon: 'search', label: 'Search' },
  { id: 'graph', icon: 'map', label: 'Graph Inspector' },
  { id: 'database', icon: 'database', label: 'Database Inspector' },
  { id: 'favourites', icon: 'heart', label: 'Favourites' },
  { id: 'tags', icon: 'tag', label: 'Tag Manager' },
  { id: 'settings', icon: 'sliders', label: 'Legato Settings' },
]
