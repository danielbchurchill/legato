import { useState } from 'react'
import { Icon } from '../ui/Icon'
import { Tabs } from '../ui/Tabs'
import { AlbumsGrid } from './AlbumsGrid'
import { TracksTable } from './TracksTable'
import { ALBUM_SORT_OPTIONS, type AlbumSort, type SortDir, type TrackSort } from './types'

/* The library view's own container (issue #126 — see DESIGN.md
 * "Library view"). Takes over the same full-bleed stage Canvas occupies in
 * AppShell (App.tsx renders one or the other, never both), so it inherits
 * the same "runs edge to edge, chrome floats over it" relationship with the
 * rail/panels — a row can legitimately scroll in and out from behind the
 * Inspector Panel's glass exactly the way a graph node already does.
 *
 * Only --rail-width is reserved as real padding: the rail itself (unlike
 * the Inspector Panel it opens) has no glass background and is always
 * present, so content starting underneath it would be genuinely hidden, not
 * just visually layered. */

type LibraryEntity = 'albums' | 'tracks'

const ENTITIES = [
  { value: 'albums', label: 'albums' },
  { value: 'tracks', label: 'tracks' },
] as const satisfies readonly { value: LibraryEntity; label: string }[]

const HEADER_ROW_HEIGHT = 33 // --spacing-row, same rhythm TracksTable's own column headers use

// Tabs' underline variant since the gpui-kit port: the same muted -> ink
// labels as before, with a sliding rule under the active one and arrow keys.
function EntitySwitch({ value, onChange }: { value: LibraryEntity; onChange: (value: LibraryEntity) => void }) {
  return <Tabs label="library layout" variant="underline" size="md" options={ENTITIES} value={value} onChange={onChange} />
}

// AlbumsGrid has no column headers to sort from (a grid of cells, not a
// table), so it gets this instead — same active/muted + direction-chevron
// language TracksTable's SortHeader uses, just laid out as one row of
// options rather than one button per column.
function AlbumSortBar({
  sort,
  dir,
  onSort,
}: {
  sort: AlbumSort
  dir: SortDir
  onSort: (sort: AlbumSort) => void
}) {
  return (
    <div className="flex items-center gap-[var(--spacing-lg)]">
      {ALBUM_SORT_OPTIONS.map((option) => {
        const active = option.id === sort
        return (
          <button
            key={option.id}
            type="button"
            onClick={() => onSort(option.id)}
            aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
            className={`flex items-center gap-[var(--spacing-xs)] text-[length:var(--text-base)] leading-[24px] transition-colors duration-[var(--motion-fast)] ${
              active ? 'text-[var(--color-ink)]' : 'text-[var(--color-muted)] hover:text-[var(--color-muted-hi)]'
            }`}
          >
            {option.label}
            {active && <Icon name={dir === 'asc' ? 'chevron-up' : 'chevron-down'} size={16} />}
          </button>
        )
      })}
    </div>
  )
}

type LibraryViewProps = {
  /** Shared with the map's own search field (App.tsx lifts it) — typing here
   * or there filters/updates the same query, and it survives switching
   * views. See DESIGN.md "Library view" for why this, and not a second,
   * independent filter concept, is what "shared search/filters" means here. */
  query: string
  onSelectNode: (id: number) => void
}

export function LibraryView({ query, onSelectNode }: LibraryViewProps) {
  const [entity, setEntity] = useState<LibraryEntity>('albums')
  const [albumSort, setAlbumSort] = useState<AlbumSort>('artist')
  const [albumDir, setAlbumDir] = useState<SortDir>('asc')
  const [trackSort, setTrackSort] = useState<TrackSort>('title')
  const [trackDir, setTrackDir] = useState<SortDir>('asc')

  // Clicking the already-active sort option flips direction, matching
  // TracksTable's own column-header behavior — one gesture for both "sort
  // by this" and "the other way round" rather than a separate control.
  const onAlbumSort = (id: AlbumSort) => {
    if (id === albumSort) setAlbumDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setAlbumSort(id)
      setAlbumDir('asc')
    }
  }
  const onTrackSort = (id: TrackSort) => {
    if (id === trackSort) setTrackDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setTrackSort(id)
      setTrackDir('asc')
    }
  }

  return (
    <div className="absolute inset-0 flex flex-col" style={{ paddingLeft: 'var(--rail-width)' }}>
      <div
        className="flex shrink-0 items-center justify-between px-[var(--spacing-lg)]"
        style={{ height: HEADER_ROW_HEIGHT, marginTop: 'calc(var(--inset) + var(--capsule-height) + var(--spacing-lg))' }}
      >
        <EntitySwitch value={entity} onChange={setEntity} />
        {entity === 'albums' && <AlbumSortBar sort={albumSort} dir={albumDir} onSort={onAlbumSort} />}
      </div>

      <div className="min-h-0 flex-1">
        {entity === 'albums' ? (
          <AlbumsGrid query={query} sort={albumSort} dir={albumDir} onSelectNode={onSelectNode} />
        ) : (
          <TracksTable query={query} sort={trackSort} dir={trackDir} onSort={onTrackSort} onSelectNode={onSelectNode} />
        )}
      </div>
    </div>
  )
}
