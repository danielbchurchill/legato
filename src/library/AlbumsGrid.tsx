import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { CoverArt } from '../ui/CoverArt'
import { PlayCircle } from '../ui/PlayCircle'
import { Button } from '../ui/Button'
import { formatCount } from '../ui/format'
import { API_BASE as API } from '../config/serverHost'
import { useLibraryPage } from './useLibraryPage'
import { GridSkeleton } from './LibrarySkeleton'
import type { AlbumRow, AlbumSort, SortDir } from './types'

/* Albums: a "Recently added" shelf, then every album as a cover grid.
 *
 * The grid is `repeat(auto-fill, minmax(168px, 1fr))` with 24px columns and
 * 28px rows, computed here rather than left to CSS grid because it's
 * virtualised: a library can hold tens of thousands of albums, and only the
 * rows on screen are rendered, a page of 150 fetched at a time
 * (useLibraryPage). The rows share the library's one scroll area with the
 * header and the shelf above them, so the virtualiser is told how far down
 * that scroll area the grid starts. */

const MIN_CELL = 168
const COLUMN_GAP = 24
const ROW_GAP = 28
const TEXT_BLOCK = 10 + 20 + 16 // gap, title line, artist line
const SHELF_SIZE = 12

type AlbumsGridProps = {
  scrollRef: RefObject<HTMLDivElement | null>
  sort: AlbumSort
  dir: SortDir
  onOpen: (id: number) => void
  onPlay: (id: number) => void
  onShowRecent: () => void
}

function AlbumCell({ album, size, onOpen, onPlay }: { album: AlbumRow; size?: number; onOpen: () => void; onPlay: () => void }) {
  const sub = [album.artistName, album.year].filter(Boolean).join(' · ')
  return (
    <div className="group flex min-w-0 flex-col gap-[10px]" style={size ? { width: size } : undefined}>
      <div className="relative transition-transform duration-[var(--motion-base)] ease-[var(--ease-out)] group-hover:-translate-y-[3px]">
        <button
          type="button"
          onClick={onOpen}
          aria-label={`${album.title}${album.artistName ? `, ${album.artistName}` : ''}`}
          className="block w-full"
        >
          <CoverArt
            nodeId={album.id}
            size="thumb"
            alt=""
            className="aspect-square w-full transition-shadow duration-[var(--motion-base)] group-hover:shadow-[var(--shadow-panel)]"
          />
        </button>
        <span className="absolute right-[10px] bottom-[10px] opacity-0 transition-opacity duration-[var(--motion-fast)] group-focus-within:opacity-100 group-hover:opacity-100">
          <PlayCircle size={40} label={`Play ${album.title}`} onClick={onPlay} />
        </span>
      </div>
      <button type="button" onClick={onOpen} tabIndex={-1} className="flex min-w-0 flex-col text-left">
        <span title={album.title} className="truncate text-[length:var(--text-body)] leading-[20px] font-medium text-[var(--color-ink)]">
          {album.title}
        </span>
        <span title={sub} className="truncate text-small text-[var(--color-ink-2)]">
          {sub}
        </span>
      </button>
    </div>
  )
}

/* The twelve newest albums, one row of 148px covers. "see all" switches the
 * grid below to newest-first rather than opening a second view. */
function RecentlyAdded({
  onOpen,
  onPlay,
  onShowRecent,
}: {
  onOpen: (id: number) => void
  onPlay: (id: number) => void
  onShowRecent: () => void
}) {
  const [albums, setAlbums] = useState<AlbumRow[] | null>(null)
  useEffect(() => {
    let cancelled = false
    fetch(`${API}/library/albums?${new URLSearchParams({ sort: 'dateAdded', dir: 'desc', limit: String(SHELF_SIZE), offset: '0' })}`)
      .then((r) => r.json())
      .then((data: { items: AlbumRow[] }) => !cancelled && setAlbums(data.items))
      .catch(() => !cancelled && setAlbums([]))
    return () => {
      cancelled = true
    }
  }, [])
  if (albums == null || albums.length === 0) return null
  return (
    <section className="mt-[28px] flex flex-col gap-[12px]">
      <div className="flex items-center justify-between">
        <h2 className="text-heading text-[var(--color-ink)]">Recently added</h2>
        <Button onClick={onShowRecent}>see all</Button>
      </div>
      {/* Clipped, not scrolled: the shelf is a glance at what's new, and the
       * grid below is the way through everything. */}
      <div className="flex gap-[20px] overflow-hidden pt-[3px]">
        {albums.map((album) => (
          <div key={album.id} className="shrink-0">
            <AlbumCell album={album} size={148} onOpen={() => onOpen(album.id)} onPlay={() => onPlay(album.id)} />
          </div>
        ))}
      </div>
    </section>
  )
}

export function AlbumsGrid({ scrollRef, sort, dir, onOpen, onPlay, onShowRecent }: AlbumsGridProps) {
  const gridRef = useRef<HTMLDivElement>(null)
  const [geometry, setGeometry] = useState({ columns: 1, cell: MIN_CELL, offset: 0 })
  const { rows, total, loading, waitVisible, ensureRange } = useLibraryPage<AlbumRow>('library/albums', '', sort, dir)

  // Columns from the grid's width, the same answer auto-fill would give, and
  // the grid's distance from the top of the scroll area for the virtualiser.
  useLayoutEffect(() => {
    const grid = gridRef.current
    if (!grid) return
    const measure = () => {
      const width = grid.clientWidth
      const columns = Math.max(1, Math.floor((width + COLUMN_GAP) / (MIN_CELL + COLUMN_GAP)))
      const cell = (width - COLUMN_GAP * (columns - 1)) / columns
      setGeometry((g) =>
        g.columns === columns && g.cell === cell && g.offset === grid.offsetTop ? g : { columns, cell, offset: grid.offsetTop },
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(grid)
    if (grid.parentElement) observer.observe(grid.parentElement)
    return () => observer.disconnect()
  }, [loading])

  const rowHeight = geometry.cell + TEXT_BLOCK + ROW_GAP
  const rowCount = Math.ceil(total / geometry.columns)
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 2,
    scrollMargin: geometry.offset,
  })
  useEffect(() => {
    virtualizer.measure()
  }, [rowHeight, virtualizer])

  const items = virtualizer.getVirtualItems()
  const firstIndex = items[0]?.index
  const lastIndex = items[items.length - 1]?.index
  useEffect(() => {
    if (firstIndex == null || lastIndex == null) return
    ensureRange(firstIndex * geometry.columns, Math.min(total - 1, (lastIndex + 1) * geometry.columns - 1))
  }, [firstIndex, lastIndex, geometry.columns, total, ensureRange])

  if (loading) return waitVisible ? <GridSkeleton /> : null

  return (
    <>
      {sort !== 'dateAdded' && <RecentlyAdded onOpen={onOpen} onPlay={onPlay} onShowRecent={onShowRecent} />}
      <div className="mt-[32px] flex items-center justify-between">
        <h2 className="text-heading text-[var(--color-ink)]">{sort === 'dateAdded' && dir === 'desc' ? 'Newest first' : 'All albums'}</h2>
        <span className="mono text-[length:var(--text-mono)] text-[var(--color-ink-2)]">{formatCount(total)}</span>
      </div>
      <div ref={gridRef} className="relative mt-[14px] w-full" style={{ height: virtualizer.getTotalSize() }}>
        {items.map((item) => {
          const start = item.index * geometry.columns
          return (
            <div
              key={item.key}
              className="absolute top-0 left-0 grid w-full"
              style={{
                transform: `translateY(${item.start - virtualizer.options.scrollMargin}px)`,
                gridTemplateColumns: `repeat(${geometry.columns}, minmax(0, 1fr))`,
                columnGap: COLUMN_GAP,
              }}
            >
              {Array.from({ length: geometry.columns }, (_, col) => {
                const index = start + col
                if (index >= total) return null
                const album = rows[index]
                return album ? (
                  <AlbumCell key={album.id} album={album} onOpen={() => onOpen(album.id)} onPlay={() => onPlay(album.id)} />
                ) : (
                  <div key={`pending-${index}`} className="flex flex-col gap-[10px]">
                    <div className="aspect-square w-full rounded-[var(--radius-art)] bg-[var(--color-wash-2)]" />
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
    </>
  )
}
