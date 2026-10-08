import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { CoverArt } from '../ui/CoverArt'
import { Equaliser } from '../ui/Equaliser'
import { Icon } from '../ui/Icon'
import { formatDuration, NO_VALUE } from '../ui/format'
import { useLibraryPage } from './useLibraryPage'
import { RowSkeleton, RowsSkeleton } from './LibrarySkeleton'
import { LibraryEmpty } from './LibraryEmpty'
import { readPx } from './tokens'
import { trackColumns, type TrackColumnId, type TrackColumns } from './trackColumns'
import type { SortDir, TrackRow, TrackSort } from './types'

/* Every track, as a virtualised table in the library's one scroll area,
 * 24px under the header. As LibraryStageV2 draws it, the header row is 32px
 * of label text over a hairline, the sorted column in ink with a 14px
 * chevron; rows are --library-track-row tall with --radius-control corners
 * and a 36px cover. The columns, and which of them give way when the table
 * is narrow, are trackColumns.ts's.
 *
 * The # column is the row's play control: the mono number at rest, a play
 * glyph on hover or focus, and for the playing track the accent equaliser
 * (with the row washed and its title in the accent). Clicking anywhere else
 * on a row opens its details. */

type Header = { label: string; sort?: TrackSort; align?: 'right' }

const HEADER: Record<TrackColumnId, Header> = {
  number: { label: '#', align: 'right' },
  cover: { label: '' },
  title: { label: 'title', sort: 'title' },
  artist: { label: 'artist', sort: 'artist' },
  album: { label: 'album', sort: 'album' },
  time: { label: 'time', sort: 'duration', align: 'right' },
  format: { label: 'format', sort: 'format' },
  added: { label: 'added', sort: 'dateAdded', align: 'right' },
}

/* "Sep 16" this year, "Sep 16 2024" before it — the year only when it adds
 * something. The server's timestamps are UTC without a zone marker. */
function formatAdded(value: string): string {
  const date = new Date(`${value.replace(' ', 'T')}Z`)
  if (Number.isNaN(date.getTime())) return NO_VALUE
  const sameYear = date.getFullYear() === new Date().getFullYear()
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) })
}

/* One track row. Memoised: the virtualiser re-renders the table on every
 * scroll event, and at 30k albums re-rendering every visible row each time
 * cost frames (#263). Its props only change when the row itself does. */
const TrackRowView = memo(function TrackRowView({
  track,
  index,
  isPlaying,
  playing,
  columns,
  y,
  onOpen,
  onPlay,
}: {
  track: TrackRow
  index: number
  isPlaying: boolean
  /** Whether playback is running, for the playing row's equaliser. */
  playing: boolean
  columns: TrackColumns
  /** The row's offset in the table body, a number so the memo holds. */
  y: number
  onOpen: (id: number) => void
  onPlay: (track: TrackRow) => void
}) {
  const cell = (id: TrackColumnId) => {
    switch (id) {
      case 'number':
        return (
          <span key={id} role="cell" className="flex justify-end">
            <button
              type="button"
              aria-label={`Play ${track.title}`}
              onClick={(e) => {
                e.stopPropagation()
                onPlay(track)
              }}
              className="grid h-[24px] min-w-[24px] place-items-center"
            >
              {isPlaying ? (
                <Equaliser playing={playing} />
              ) : (
                <>
                  <span className="mono text-mono text-[var(--color-ink-3)] group-focus-within:hidden group-hover:hidden">{index + 1}</span>
                  <span className="hidden text-[var(--color-ink)] group-focus-within:inline-flex group-hover:inline-flex">
                    <Icon name="play" size={16} filled />
                  </span>
                </>
              )}
            </button>
          </span>
        )
      case 'cover':
        return (
          <span key={id} role="cell">
            <CoverArt nodeId={track.albumId ?? track.id} size="thumb" radius="sm" className="size-[36px]" />
          </span>
        )
      case 'title':
        return (
          <span
            key={id}
            role="cell"
            title={track.title}
            className={`truncate text-[length:var(--text-body)] leading-[20px] font-medium ${isPlaying ? 'text-[var(--color-accent)]' : 'text-[var(--color-ink)]'}`}
          >
            {track.title}
          </span>
        )
      case 'artist':
      case 'album': {
        const value = id === 'artist' ? track.artistName : track.albumTitle
        return (
          <span
            key={id}
            role="cell"
            title={value ?? undefined}
            className="truncate text-[length:var(--text-secondary)] leading-[18px] text-[var(--color-ink-2)]"
          >
            {value ?? NO_VALUE}
          </span>
        )
      }
      case 'time':
        return (
          <span key={id} role="cell" className="mono text-right text-mono text-[var(--color-ink-2)]">
            {formatDuration(track.durationMs)}
          </span>
        )
      case 'format':
        return (
          <span key={id} role="cell">
            {track.format && (
              <span className="mono inline-block rounded-[var(--radius-small)] border border-[var(--color-line-strong)] px-[5px] py-px text-[10px] tracking-[0.04em] text-[var(--color-ink-2)]">
                {track.format.toUpperCase()}
              </span>
            )}
          </span>
        )
      case 'added':
        return (
          <span key={id} role="cell" className="mono text-right text-mono text-[var(--color-ink-3)]">
            {formatAdded(track.dateAdded)}
          </span>
        )
    }
  }

  return (
    <div
      role="row"
      aria-rowindex={index + 1}
      aria-current={isPlaying ? 'true' : undefined}
      onClick={() => onOpen(track.id)}
      className={`group absolute top-0 left-0 grid h-[var(--library-track-row)] w-full cursor-default items-center rounded-[var(--radius-control)] transition-colors duration-[var(--motion-fast)] ${
        isPlaying ? 'bg-[var(--color-wash-2)]' : 'hover:bg-[var(--color-wash)]'
      }`}
      style={{ ...columns.style, transform: `translateY(${y}px)` }}
    >
      {columns.ids.map(cell)}
    </div>
  )
})

type TracksTableProps = {
  scrollRef: RefObject<HTMLDivElement | null>
  sort: TrackSort
  dir: SortDir
  onSort: (sort: TrackSort, dir: SortDir) => void
  playingId: number | null
  playing: boolean
  onOpen: (id: number) => void
  onPlay: (track: TrackRow) => void
}

export function TracksTable({ scrollRef, sort, dir, onSort, playingId, playing, onOpen, onPlay }: TracksTableProps) {
  const tableRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState<number | null>(null)
  const [offset, setOffset] = useState(0)
  const [rowHeight, setRowHeight] = useState<number | null>(null)
  const { rows, total, loading, waitVisible, ensureRange } = useLibraryPage<TrackRow>('library/tracks', '', sort, dir)

  // The table's width picks its columns; a panel opening or closing
  // narrows or widens it.
  useLayoutEffect(() => {
    const table = tableRef.current
    if (!table) return
    const measure = () => setWidth(table.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(table)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    const body = bodyRef.current
    if (!body) return
    const measure = () => {
      setOffset(body.offsetTop)
      setRowHeight(readPx(body, '--library-track-row'))
    }
    measure()
    const observer = new ResizeObserver(measure)
    if (body.parentElement) observer.observe(body.parentElement)
    return () => observer.disconnect()
  }, [loading, total])

  const virtualizer = useVirtualizer({
    // Nothing until the row height is known: zero would put every row on
    // screen at once.
    count: rowHeight ? total : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight ?? 0,
    overscan: 8,
    scrollMargin: offset,
  })
  const items = virtualizer.getVirtualItems()
  const firstIndex = items[0]?.index
  const lastIndex = items[items.length - 1]?.index
  useEffect(() => {
    if (firstIndex == null || lastIndex == null) return
    ensureRange(firstIndex, lastIndex)
  }, [firstIndex, lastIndex, ensureRange])

  // Until the table has a width, every column; the measurement lands before
  // the first paint. Memoised so the rows' memo holds while scrolling.
  const columns = useMemo(() => trackColumns(width ?? Number.POSITIVE_INFINITY, sort), [width, sort])

  return (
    <div ref={tableRef} role="table" aria-label="Tracks" aria-rowcount={total} className="mt-[24px]">
      <div
        role="row"
        className="box-content grid h-[32px] items-center border-b border-[var(--color-line)] text-label text-[var(--color-ink-2)]"
        style={columns.style}
      >
        {columns.ids.map((id) => {
          const column = HEADER[id]
          const align = column.align === 'right'
          if (!column.sort) {
            return (
              <span key={id} role="columnheader" className={align ? 'text-right' : ''}>
                {column.label}
              </span>
            )
          }
          const columnSort = column.sort
          const active = columnSort === sort
          return (
            <span key={id} role="columnheader" aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
              <button
                type="button"
                onClick={() => onSort(columnSort, active ? (dir === 'asc' ? 'desc' : 'asc') : columnSort === 'dateAdded' ? 'desc' : 'asc')}
                className={`flex w-full items-center gap-[4px] transition-colors duration-[var(--motion-fast)] hover:text-[var(--color-ink)] ${
                  align ? 'justify-end' : ''
                } ${active ? 'text-[var(--color-ink)]' : ''}`}
              >
                {column.label}
                {active && <Icon name={dir === 'asc' ? 'chevron-up' : 'chevron-down'} size={14} />}
              </button>
            </span>
          )
        })}
      </div>

      {loading ? (
        waitVisible && <RowsSkeleton columns={columns} />
      ) : total === 0 ? (
        <LibraryEmpty title="No tracks yet" body="Tracks appear here as your folders are read." />
      ) : (
        <div ref={bodyRef} className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {items.map((item) => {
            const track = rows[item.index]
            const y = item.start - virtualizer.options.scrollMargin
            if (!track) {
              return (
                <RowSkeleton
                  key={item.key}
                  columns={columns}
                  className="absolute top-0 left-0 w-full"
                  style={{ transform: `translateY(${y}px)` }}
                />
              )
            }
            const isPlaying = track.id === playingId
            return (
              <TrackRowView
                key={item.key}
                track={track}
                index={item.index}
                isPlaying={isPlaying}
                playing={isPlaying && playing}
                columns={columns}
                y={y}
                onOpen={onOpen}
                onPlay={onPlay}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}
