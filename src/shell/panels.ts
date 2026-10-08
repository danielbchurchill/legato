import type { IconName } from '../ui/Icon'

/* What the two side panels can show.
 *
 * v2 folds the seven shipped rail destinations into three: Collections
 * (favourites, playlists, playlist import), Library health (the database
 * inspector, tag manager and maintenance worklists) and Settings. Map
 * settings moved to the map's own toolbar. A sub-page — one playlist, the
 * import flow, one worklist — still belongs to its rail item, which stays
 * highlighted while it's open. */

export type WorklistKind = 'duplicates' | 'missing' | 'enrichment' | 'tag-writes' | 'gaps'

export type LeftView =
  | { kind: 'collections' }
  | { kind: 'playlist'; playlistId: number }
  | { kind: 'import' }
  | { kind: 'health' }
  | { kind: 'worklist'; list: WorklistKind }
  | { kind: 'settings' }

export type RailItem = 'collections' | 'health' | 'settings'

export const RAIL_ITEMS: { id: RailItem; icon: IconName; label: string }[] = [
  { id: 'collections', icon: 'list', label: 'Collections' },
  { id: 'health', icon: 'database', label: 'Library health' },
]

export const SETTINGS_ITEM = { id: 'settings', icon: 'settings', label: 'Settings' } as const satisfies {
  id: RailItem
  icon: IconName
  label: string
}

/** The rail item a view belongs to, so a sub-page keeps its parent lit. */
export function railOwner(view: LeftView | null): RailItem | null {
  if (view == null) return null
  switch (view.kind) {
    case 'collections':
    case 'playlist':
    case 'import':
      return 'collections'
    case 'health':
    case 'worklist':
      return 'health'
    case 'settings':
      return 'settings'
  }
}

export type RightView = 'queue' | 'details'
export type NowPlayingTab = 'next' | 'lyrics' | 'details'
export type DetailsTab = 'overview' | 'tracks' | 'credits' | 'metadata'
