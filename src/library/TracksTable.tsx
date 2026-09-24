import { useEffect, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Icon } from '../ui/Icon'
import { ScrollingText } from '../ui/ScrollingText'
import { formatDuration, NO_VALUE } from '../ui/format'
import { useLibraryPage } from './useLibraryPage'
import { TRACK_SORT_OPTIONS, type SortDir, type TrackRow, type TrackSort } from './types'

// Shared between the header row and every data row so their columns stay
// pixel-aligned — see AlbumsGrid's own note on why this view has no Figma
// frame yet: title/artist/album share the remaining space 3:2:2 (title
// reads longest on average), duration/format/date added are fixed because
// none of them benefit from growing with the window.
const GRID_TEMPLATE = 'minmax(0,3fr) minmax(0,2fr) minmax(0,2fr) 64px 64px 96px'
const ROW_HEIGHT = 33 // --spacing-row: DataRow's own "vertical pitch of a label/value row"

type TracksTableProps = {
  query: string
  sort: TrackSort
  dir: SortDir
  onSort: (sort: TrackSort) => void
  onSelectNode: (id: number) => void
}

function SortHeader({
  id,
  label,
  align,
  sort,
  dir,
  onSort,
}: {
  id: TrackSort
  label: string
  align?: 'right'
  sort: TrackSort
  dir: SortDir
  onSort: (sort: TrackSort) => void
}) {
  const active = id === sort
  return (
    <button
      type="button"
      onClick={() => onSort(id)}
      aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={`flex items-center gap-[var(--spacing-xs)] text-[length:var(--text-base)] leading-[24px] transition-colors duration-[var(--motion-fast)] ${
        align === 'right' ? 'flex-row-reverse justify-end' : ''
      } ${active ? 'text-[var(--color-ink)]' : 'text-[var(--color-muted)] hover:text-[var(--color-muted-hi)]'}`}
    >
      {label}
      {active && <Icon name={dir === 'asc' ? 'chevron-up' : 'chevron-down'} size={16} />}
    </button>
  )
}

/** Virtualized track table (issue #126, D11): a flat list, one row per
 * recording, unlike AlbumsGrid's row-of-cells — @tanstack/react-virtual's
 * plain linear-list mode applies directly, no column-count measuring
 * needed. Same windowed useLibraryPage underneath, same "smooth at 30k"
 * reasoning as the grid.
 *
 * Clicking a header re-sorts on that column (toggling direction on a second
 * click on the same one); clicking a row selects+flies, same as every other
 * row in the app that names a node. No per-row play button — see
 * AlbumsGrid's note on why that's a deliberate follow-up, not an oversight. */
export function TracksTable({ query, sort, dir, onSort, onSelectNode }: TracksTableProps) {
  const parentRef = useRef<HTMLDivElement>(null)
  const { rows, total, ensureRange } = useLibraryPage<TrackRow>('library/tracks', query, sort, dir)

  const rowVirtualizer = useVirtualizer({
    count: total,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  })

  const virtualRows = rowVirtualizer.getVirtualItems()
  const firstIndex = virtualRows[0]?.index
  const lastIndex = virtualRows[virtualRows.length - 1]?.index
  useEffect(() => {
    if (firstIndex == null || lastIndex == null) return
    ensureRange(firstIndex, lastIndex)
  }, [firstIndex, lastIndex, ensureRange])

  return (
    <div className="flex h-full flex-col">
      <div
        role="row"
        className="grid shrink-0 gap-[var(--spacing-sm)] border-b border-[var(--color-divider)] px-[var(--spacing-lg)]"
        style={{ gridTemplateColumns: GRID_TEMPLATE, height: ROW_HEIGHT }}
      >
        {TRACK_SORT_OPTIONS.map((option) => (
          <SortHeader
            key={option.id}
            id={option.id}
            label={option.label}
            align={option.id === 'duration' ? 'right' : undefined}
            sort={sort}
            dir={dir}
            onSort={onSort}
          />
        ))}
      </div>

      {total === 0 && rows.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-[length:var(--text-base)] text-[var(--color-muted)]">
            {query ? `no tracks match "${query}"` : 'no tracks yet'}
          </p>
        </div>
      ) : (
        <div ref={parentRef} className="relative flex-1 overflow-y-auto">
          <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
            {virtualRows.map((virtualRow) => {
              const track = rows[virtualRow.index]
              return (
                <div
                  key={virtualRow.key}
                  role="row"
                  className="absolute top-0 left-0 w-full"
                  style={{ transform: `translateY(${virtualRow.start}px)`, height: ROW_HEIGHT }}
                >
                  {track ? (
                    <button
                      type="button"
                      onClick={() => onSelectNode(track.id)}
                      className="grid h-full w-full items-center gap-[var(--spacing-sm)] px-[var(--spacing-lg)] text-left transition-colors duration-150 hover:bg-[var(--color-hover-wash)]"
                      style={{ gridTemplateColumns: GRID_TEMPLATE }}
                    >
                      <ScrollingText
                        text={track.title}
                        className="min-w-0 font-[family-name:var(--font-mono)] text-[length:var(--text-base)] leading-[24px] text-[var(--color-ink)]"
                      />
                      <ScrollingText
                        text={track.artistName ?? NO_VALUE}
                        className="min-w-0 font-[family-name:var(--font-mono)] text-[length:var(--text-base)] leading-[24px] text-[var(--color-ink)]"
                      />
                      <ScrollingText
                        text={track.albumTitle ?? NO_VALUE}
                        className="min-w-0 font-[family-name:var(--font-mono)] text-[length:var(--text-base)] leading-[24px] text-[var(--color-ink)]"
                      />
                      <span className="text-right font-[family-name:var(--font-mono)] text-[length:var(--text-base)] leading-[24px] text-[var(--color-ink)]">
                        {formatDuration(track.durationMs)}
                      </span>
                      <span className="truncate font-[family-name:var(--font-mono)] text-[length:var(--text-base)] leading-[24px] text-[var(--color-ink)]">
                        {track.format ?? NO_VALUE}
                      </span>
                      <span className="truncate font-[family-name:var(--font-mono)] text-[length:var(--text-base)] leading-[24px] text-[var(--color-ink)]">
                        {track.dateAdded.slice(0, 10)}
                      </span>
                    </button>
                  ) : (
                    <div aria-hidden className="h-full w-full bg-[var(--color-placeholder)]" />
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
