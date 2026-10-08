import { memo, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { CoverArt } from '../ui/CoverArt'
import { PlayCircle } from '../ui/PlayCircle'
import { Button } from '../ui/Button'
import { formatCount } from '../ui/format'
import { API_BASE as API } from '../config/serverHost'
import { useLibraryPage } from './useLibraryPage'
import { CellSkeleton, GridSkeleton } from './LibrarySkeleton'
import { LibraryEmpty } from './LibraryEmpty'
import { readPx } from './tokens'
import type { AlbumRow, AlbumSort, SortDir } from './types'

/* Albums, as LibraryStageV2 draws them: a "Recently added" shelf, then every
 * album as a cover grid. The shelf sits 28px under the header with its
 * covers 12px under its heading; "All albums" is 32px under the shelf and
 * the grid 14px under that.
 *
 * The grid is repeat(auto-fill, minmax(--library-cell-min, 1fr)) with
 * --library-column-gap and --library-row-gap between cells, worked out here
 * rather than left to CSS grid because it's virtualised: a library can hold
 * tens of thousands of albums, and only the rows on screen are rendered, a
 * page of 150 fetched at a time (useLibraryPage). The rows share the
 * library's one scroll area with the header and the shelf above them, so
 * the virtualiser is told how far down that scroll area the grid starts. */

/* Under a grid cover: the frame's 10px gap, then a text-body title line (20)
 * and a text-small "Artist · Year" line (16). The cover's own width, this,
 * and the row gap make one virtualised row. */
const TEXT_BLOCK = 10 + 20 + 16

type AlbumsGridProps = {
  scrollRef: RefObject<HTMLDivElement | null>
  sort: AlbumSort
  dir: SortDir
  onOpen: (id: number) => void
  onPlay: (id: number) => void
  onShowRecent: () => void
}

/* A cover with its title and artist under it. On hover the cover lifts 3px
 * into --shadow-panel and the 40px play button shows 10px in from its
 * corner. The shelf's cells are a fixed --library-shelf-cover wide with 8px
 * under the cover and the artist alone; the grid's fill their column with
 * 10px and "Artist · Year", as the frame captions each.
 *
 * Memoised, and handed the grid's own callbacks rather than a closure per
 * cell: the virtualiser re-renders the grid on every scroll event, and at
 * 30k albums re-rendering every visible cell each time cost frames (#263). */
const AlbumCell = memo(function AlbumCell({
  album,
  shelf = false,
  onOpen,
  onPlay,
}: {
  album: AlbumRow
  shelf?: boolean
  onOpen: (id: number) => void
  onPlay: (id: number) => void
}) {
  const sub = shelf ? (album.artistName ?? '') : [album.artistName, album.year].filter(Boolean).join(' · ')
  return (
    <div className={`group flex min-w-0 flex-col ${shelf ? 'w-[var(--library-shelf-cover)] gap-[8px]' : 'gap-[10px]'}`}>
      <div className="relative transition-transform duration-[var(--motion-base)] ease-[var(--ease-out)] group-hover:-translate-y-[3px]">
        <button
          type="button"
          onClick={() => onOpen(album.id)}
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
          <PlayCircle size={40} label={`Play ${album.title}`} onClick={() => onPlay(album.id)} />
        </span>
      </div>
      <button type="button" onClick={() => onOpen(album.id)} tabIndex={-1} className="flex min-w-0 flex-col text-left">
        <span title={album.title} className="truncate text-[length:var(--text-body)] leading-[20px] font-medium text-[var(--color-ink)]">
          {album.title}
        </span>
        <span title={sub} className="truncate text-small text-[var(--color-ink-2)]">
          {sub}
        </span>
      </button>
    </div>
  )
})

/* The newest albums, one row of covers. "see all" switches the grid below to
 * newest-first rather than opening a second view. The row is clipped, not
 * scrolled: the shelf is a glance at what's new, and the grid below is the
 * way through everything. It asks for as many covers as its width holds,
 * counting the one the edge cuts, so the row is full at any window size. */
function RecentlyAdded({
  onOpen,
  onPlay,
  onShowRecent,
}: {
  onOpen: (id: number) => void
  onPlay: (id: number) => void
  onShowRecent: () => void
}) {
  const widthRef = useRef<HTMLDivElement>(null)
  const [fit, setFit] = useState(0)
  const [albums, setAlbums] = useState<AlbumRow[] | null>(null)

  useLayoutEffect(() => {
    const element = widthRef.current
    if (!element) return
    const measure = () => {
      const cover = readPx(element, '--library-shelf-cover')
      const gap = readPx(element, '--library-shelf-gap')
      if (cover == null || gap == null) return
      // Only ever grows: covers past a narrowing edge are clipped anyway.
      setFit((n) => Math.max(n, Math.ceil((element.clientWidth + gap) / (cover + gap))))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (fit === 0) return
    let cancelled = false
    fetch(`${API}/library/albums?${new URLSearchParams({ sort: 'dateAdded', dir: 'desc', limit: String(fit), offset: '0' })}`)
      .then((r) => r.json())
      .then((data: { items: AlbumRow[] }) => !cancelled && setAlbums(data.items))
      .catch(() => !cancelled && setAlbums([]))
    return () => {
      cancelled = true
    }
  }, [fit])

  return (
    <div ref={widthRef}>
      {albums != null && albums.length > 0 && (
        <section className="mt-[28px] flex flex-col gap-[12px]">
          <div className="flex items-center justify-between">
            <h2 className="text-heading text-[var(--color-ink)]">Recently added</h2>
            <Button onClick={onShowRecent}>see all</Button>
          </div>
          {/* The 3px above the covers is the hover lift's room inside the
           * clip, taken back from the gap so the covers sit where the frame
           * puts them. */}
          <div className="-mt-[3px] flex gap-[var(--library-shelf-gap)] overflow-hidden pt-[3px]">
            {albums.map((album) => (
              <div key={album.id} className="shrink-0">
                <AlbumCell album={album} shelf onOpen={onOpen} onPlay={onPlay} />
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

type Geometry = { columns: number; cell: number; rowGap: number; offset: number }

export function AlbumsGrid({ scrollRef, sort, dir, onOpen, onPlay, onShowRecent }: AlbumsGridProps) {
  const gridRef = useRef<HTMLDivElement>(null)
  const [geometry, setGeometry] = useState<Geometry | null>(null)
  const { rows, total, loading, waitVisible, ensureRange } = useLibraryPage<AlbumRow>('library/albums', '', sort, dir)

  // Columns from the grid's width, the same answer auto-fill gives the
  // skeleton and the artists grid, and the grid's distance from the top of
  // the scroll area for the virtualiser.
  useLayoutEffect(() => {
    const grid = gridRef.current
    if (!grid) return
    const measure = () => {
      const min = readPx(grid, '--library-cell-min')
      const columnGap = readPx(grid, '--library-column-gap')
      const rowGap = readPx(grid, '--library-row-gap')
      if (min == null || columnGap == null || rowGap == null) return
      const width = grid.clientWidth
      const columns = Math.max(1, Math.floor((width + columnGap) / (min + columnGap)))
      const cell = (width - columnGap * (columns - 1)) / columns
      const offset = grid.offsetTop
      setGeometry((g) =>
        g && g.columns === columns && g.cell === cell && g.rowGap === rowGap && g.offset === offset ? g : { columns, cell, rowGap, offset },
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(grid)
    if (grid.parentElement) observer.observe(grid.parentElement)
    return () => observer.disconnect()
  }, [loading, total])

  const columns = geometry?.columns ?? 1
  const rowHeight = geometry ? geometry.cell + TEXT_BLOCK + geometry.rowGap : 0
  const virtualizer = useVirtualizer({
    // Nothing until the geometry is known: a row height of zero would
    // put every row on screen at once.
    count: geometry ? Math.ceil(total / columns) : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 2,
    scrollMargin: geometry?.offset ?? 0,
  })
  useEffect(() => {
    virtualizer.measure()
  }, [rowHeight, virtualizer])

  const items = virtualizer.getVirtualItems()
  const firstIndex = items[0]?.index
  const lastIndex = items[items.length - 1]?.index
  useEffect(() => {
    if (firstIndex == null || lastIndex == null) return
    ensureRange(firstIndex * columns, Math.min(total - 1, (lastIndex + 1) * columns - 1))
  }, [firstIndex, lastIndex, columns, total, ensureRange])

  if (loading) return waitVisible ? <GridSkeleton label="Loading albums" /> : null
  if (total === 0) return <LibraryEmpty title="No albums yet" body="Tracks without an album tag are listed under tracks." />

  return (
    <>
      {sort !== 'dateAdded' && <RecentlyAdded onOpen={onOpen} onPlay={onPlay} onShowRecent={onShowRecent} />}
      <div className="mt-[32px] flex items-center justify-between">
        <h2 className="text-heading text-[var(--color-ink)]">{sort === 'dateAdded' && dir === 'desc' ? 'Newest first' : 'All albums'}</h2>
        <span className="mono text-mono text-[var(--color-ink-2)]">{formatCount(total)}</span>
      </div>
      <div ref={gridRef} className="relative mt-[14px] w-full" style={{ height: virtualizer.getTotalSize() }}>
        {items.map((item) => {
          const start = item.index * columns
          return (
            <div
              key={item.key}
              className="absolute top-0 left-0 grid w-full gap-x-[var(--library-column-gap)]"
              style={{
                transform: `translateY(${item.start - virtualizer.options.scrollMargin}px)`,
                gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
              }}
            >
              {Array.from({ length: columns }, (_, col) => {
                const index = start + col
                if (index >= total) return null
                const album = rows[index]
                return album ? (
                  <AlbumCell key={album.id} album={album} onOpen={onOpen} onPlay={onPlay} />
                ) : (
                  <CellSkeleton key={`pending-${index}`} />
                )
              })}
            </div>
          )
        })}
      </div>
    </>
  )
}
