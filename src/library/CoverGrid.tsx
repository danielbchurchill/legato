import { Fragment, type ReactNode, type RefObject } from 'react'
import { useCoverGrid } from './useCoverGrid'
import { CellSkeleton } from './LibrarySkeleton'

/* The albums and artists grids' rows, one copy for both (#302). Each
 * virtualised row sits at its own offset down the grid with the grid's
 * columns, and holds a cell for every item its page has loaded and a
 * skeleton cell for every item still on its way. The last row holds only
 * the items there are. What a cell looks like is the caller's: an album's
 * square cover, an artist's round photo. */

type CoverGridProps<Row extends { id: number }> = {
  scrollRef: RefObject<HTMLDivElement | null>
  /** useLibraryPage's sparse rows, `total` long. */
  rows: (Row | undefined)[]
  total: number
  ensureRange: (startIndex: number, endIndex: number) => void
  /** Round skeletons, under round photos. */
  round?: boolean
  renderCell: (row: Row) => ReactNode
}

export function CoverGrid<Row extends { id: number }>({ scrollRef, rows, total, ensureRange, round, renderCell }: CoverGridProps<Row>) {
  const { gridRef, columns, items, height, scrollMargin } = useCoverGrid({ scrollRef, total, ensureRange })

  return (
    <div ref={gridRef} className="relative mt-[14px] w-full" style={{ height }}>
      {items.map((item) => {
        const start = item.index * columns
        return (
          <div
            key={item.key}
            className="absolute top-0 left-0 grid w-full gap-x-[var(--library-column-gap)]"
            style={{
              transform: `translateY(${item.start - scrollMargin}px)`,
              gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
            }}
          >
            {Array.from({ length: columns }, (_, col) => {
              const index = start + col
              if (index >= total) return null
              const row = rows[index]
              return row ? <Fragment key={row.id}>{renderCell(row)}</Fragment> : <CellSkeleton key={`pending-${index}`} round={round} />
            })}
          </div>
        )
      })}
    </div>
  )
}
