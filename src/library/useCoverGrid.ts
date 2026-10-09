import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { readPx } from './tokens'

/* The albums and artists grids' virtualisation, one copy for both, so the
 * two scroll and page alike (#302). CoverGrid renders the rows it places.
 *
 * The grid is repeat(auto-fill, minmax(--library-cell-min, 1fr)) with
 * --library-column-gap and --library-row-gap between cells, worked out here
 * rather than left to CSS grid because it's virtualised: a library can hold
 * tens of thousands of albums and thousands of artists, and only the rows on
 * screen are rendered, a page of 150 fetched at a time (useLibraryPage). The
 * rows share the library's one scroll area with the header (and the albums'
 * shelf) above them, so the virtualiser is told how far down that scroll
 * area the grid starts. */

/* Under a grid cover: the frame's 10px gap, then a text-body line (20) and a
 * text-small line (16) — an album's title and "Artist · Year", an artist's
 * name and album count. The cover's own width, this, and the row gap make
 * one virtualised row. */
const TEXT_BLOCK = 10 + 20 + 16

type Geometry = { columns: number; cell: number; rowGap: number; offset: number }

type CoverGridOptions = {
  scrollRef: RefObject<HTMLDivElement | null>
  total: number
  ensureRange: (startIndex: number, endIndex: number) => void
}

export function useCoverGrid({ scrollRef, total, ensureRange }: CoverGridOptions) {
  const gridRef = useRef<HTMLDivElement>(null)
  const [geometry, setGeometry] = useState<Geometry | null>(null)

  // Columns from the grid's width, the same answer auto-fill gives the
  // skeleton, and the grid's distance from the top of the scroll area for
  // the virtualiser. CoverGrid only mounts once the first page is in, with
  // the grid element, so measuring on mount and on every resize after it
  // is enough.
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
  }, [])

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

  return { gridRef, columns, items, height: virtualizer.getTotalSize(), scrollMargin: virtualizer.options.scrollMargin }
}
