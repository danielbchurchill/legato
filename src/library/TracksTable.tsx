import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { CoverArt } from '../ui/CoverArt'
import { Equaliser } from '../ui/Equaliser'
import { Icon } from '../ui/Icon'
import { formatDuration, NO_VALUE } from '../ui/format'
import { useLibraryPage } from './useLibraryPage'
import { RowsSkeleton } from './LibrarySkeleton'
import type { SortDir, TrackRow, TrackSort } from './types'

/* Every track, as a virtualised table: #, art, title, artist, album, time,
 * format, added. 48px rows in the library's one scroll area.
 *
 * The # column is the row's play control: the mono number at rest, a play
 * glyph on hover or focus, and for the playing track the accent equaliser
 * (with the row washed and its title in the accent). Clicking anywhere else
 * on a row opens its details. */

const COLUMNS = '36px 40px minmax(0,3fr) minmax(0,2fr) minmax(0,2fr) 64px 56px 92px'
const ROW_HEIGHT = 48

type Column = { id: TrackSort | null; label: string; align?: 'right' }

const HEADER: Column[] = [
  { id: null, label: '#', align: 'right' },
  { id: null, label: '' },
  { id: 'title', label: 'title' },
  { id: 'artist', label: 'artist' },
  { id: 'album', label: 'album' },
  { id: 'duration', label: 'time', align: 'right' },
  { id: 'format', label: 'format' },
  { id: 'dateAdded', label: 'added', align: 'right' },
]

/* "Sep 16" this year, "Sep 16 2024" before it — the year only when it adds
 * something. The server's timestamps are UTC without a zone marker. */
function formatAdded(value: string): string {
  const date = new Date(`${value.replace(' ', 'T')}Z`)
  if (Number.isNaN(date.getTime())) return NO_VALUE
  const sameYear = date.getFullYear() === new Date().getFullYear()
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) })
}

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
  const bodyRef = useRef<HTMLDivElement>(null)
  const [offset, setOffset] = useState(0)
  const { rows, total, loading, waitVisible, ensureRange } = useLibraryPage<TrackRow>('library/tracks', '', sort, dir)

  useLayoutEffect(() => {
    const body = bodyRef.current
    if (!body) return
    const measure = () => setOffset(body.offsetTop)
    measure()
    const observer = new ResizeObserver(measure)
    if (body.parentElement) observer.observe(body.parentElement)
    return () => observer.disconnect()
  }, [loading])

  const virtualizer = useVirtualizer({
    count: total,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
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

  return (
    <div role="table" aria-label="Tracks" aria-rowcount={total} className="mt-[24px]">
      <div
        role="row"
        className="grid h-[32px] items-center gap-x-[14px] border-b border-[var(--color-line)] px-[12px] text-label text-[var(--color-ink-2)]"
        style={{ gridTemplateColumns: COLUMNS }}
      >
        {HEADER.map((column, i) => {
          const active = column.id === sort
          if (!column.id) {
            return (
              <span key={i} role="columnheader" className={column.align === 'right' ? 'text-right' : ''}>
                {column.label}
              </span>
            )
          }
          const id = column.id
          return (
            <span key={i} role="columnheader" aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
              <button
                type="button"
                onClick={() => onSort(id, active ? (dir === 'asc' ? 'desc' : 'asc') : id === 'dateAdded' ? 'desc' : 'asc')}
                className={`flex w-full items-center gap-[4px] transition-colors duration-[var(--motion-fast)] hover:text-[var(--color-ink)] ${
                  column.align === 'right' ? 'justify-end' : ''
                } ${active ? 'text-[var(--color-ink)]' : ''}`}
              >
                {column.label}
                {active && <Icon name={dir === 'asc' ? 'chevron-up' : 'chevron-down'} size={12} />}
              </button>
            </span>
          )
        })}
      </div>

      {loading ? (
        waitVisible && <RowsSkeleton />
      ) : (
        <div ref={bodyRef} className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {items.map((item) => {
            const track = rows[item.index]
            const style = { transform: `translateY(${item.start - virtualizer.options.scrollMargin}px)`, gridTemplateColumns: COLUMNS }
            if (!track) {
              return <div key={item.key} className="absolute top-0 left-0 h-[48px] w-full" style={style} />
            }
            const isPlaying = track.id === playingId
            return (
              <div
                key={item.key}
                role="row"
                aria-rowindex={item.index + 1}
                aria-current={isPlaying ? 'true' : undefined}
                onClick={() => onOpen(track.id)}
                className={`group absolute top-0 left-0 grid h-[48px] w-full cursor-default items-center gap-x-[14px] rounded-[var(--radius-control)] px-[12px] transition-colors duration-[var(--motion-fast)] ${
                  isPlaying ? 'bg-[var(--color-wash-2)]' : 'hover:bg-[var(--color-wash)]'
                }`}
                style={style}
              >
                <span role="cell" className="flex justify-end">
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
                        <span className="mono text-[length:var(--text-mono)] text-[var(--color-ink-3)] group-focus-within:hidden group-hover:hidden">
                          {item.index + 1}
                        </span>
                        <span className="hidden text-[var(--color-ink)] group-focus-within:inline-flex group-hover:inline-flex">
                          <Icon name="play" size={16} filled />
                        </span>
                      </>
                    )}
                  </button>
                </span>
                <span role="cell">
                  <CoverArt nodeId={track.albumId ?? track.id} size="thumb" radius="sm" className="size-[36px]" />
                </span>
                <span
                  role="cell"
                  title={track.title}
                  className={`truncate text-[length:var(--text-body)] leading-[20px] font-medium ${isPlaying ? 'text-[var(--color-accent)]' : 'text-[var(--color-ink)]'}`}
                >
                  {track.title}
                </span>
                <span
                  role="cell"
                  title={track.artistName ?? undefined}
                  className="truncate text-[length:var(--text-secondary)] leading-[18px] text-[var(--color-ink-2)]"
                >
                  {track.artistName ?? NO_VALUE}
                </span>
                <span
                  role="cell"
                  title={track.albumTitle ?? undefined}
                  className="truncate text-[length:var(--text-secondary)] leading-[18px] text-[var(--color-ink-2)]"
                >
                  {track.albumTitle ?? NO_VALUE}
                </span>
                <span role="cell" className="mono text-right text-[length:var(--text-mono)] text-[var(--color-ink-2)]">
                  {formatDuration(track.durationMs)}
                </span>
                <span role="cell">
                  {track.format && (
                    <span className="mono inline-block rounded-[var(--radius-small)] border border-[var(--color-line-strong)] px-[5px] py-px text-[10px] tracking-[0.04em] text-[var(--color-ink-2)]">
                      {track.format.toUpperCase()}
                    </span>
                  )}
                </span>
                <span role="cell" className="mono text-right text-[length:var(--text-mono)] text-[var(--color-ink-3)]">
                  {formatAdded(track.dateAdded)}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
