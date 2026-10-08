import type { CSSProperties } from 'react'
import { Skeleton } from '../ui/Skeleton'
import type { TrackColumns } from './trackColumns'

/* Loading: placeholders in the exact shape of what's coming, LibraryStageV2's
 * loading state. They stand in twice: for the first page, under the header,
 * and for any cell or row whose page hasn't landed yet while scrolling, so
 * nothing jumps when the real one arrives. Breathing opacity only, never a
 * travelling shimmer (DESIGN.md Motion). */

/* The first page's twelve fade from full to a quarter, so the block reads as
 * "more below" rather than as a wall. */
const fade = (i: number) => ({ opacity: Math.max(0.25, 1 - i * 0.07) })

/* A cover, a title line and an artist line, as the frame draws a cell
 * loading: the lines 12 and 10 tall at 72% and 48% of the cover's width. */
export function CellSkeleton({ round = false, style }: { round?: boolean; style?: CSSProperties }) {
  return (
    <div className={`flex flex-col gap-[10px] ${round ? 'items-center' : ''}`} style={style}>
      <Skeleton className={`aspect-square w-full ${round ? 'rounded-full' : 'rounded-[var(--radius-art)]'}`} />
      <Skeleton className="h-[12px] w-[72%] rounded-[6px]" />
      <Skeleton tone="faint" className="h-[10px] w-[48%] rounded-[6px]" />
    </div>
  )
}

export function GridSkeleton({ round = false, label }: { round?: boolean; label: string }) {
  return (
    <div
      aria-busy="true"
      aria-label={label}
      className="mt-[28px] grid grid-cols-[repeat(auto-fill,minmax(var(--library-cell-min),1fr))] gap-x-[var(--library-column-gap)] gap-y-[var(--library-row-gap)]"
    >
      {Array.from({ length: 12 }, (_, i) => (
        <CellSkeleton key={i} round={round} style={fade(i)} />
      ))}
    </div>
  )
}

/* A track row on the table's own columns (trackColumns.ts), so a
 * placeholder lines up with the rows around it at any width: the number,
 * the 36px cover, and a line for each text column. */
export function RowSkeleton({ columns, className = '', style }: { columns: TrackColumns; className?: string; style?: CSSProperties }) {
  return (
    <div className={`grid h-[var(--library-track-row)] items-center ${className}`} style={{ ...columns.style, ...style }}>
      {columns.ids.map((id) => {
        switch (id) {
          case 'number':
            return <Skeleton key={id} tone="faint" className="h-[10px] w-[20px] justify-self-end rounded-[4px]" />
          case 'cover':
            return <Skeleton key={id} className="size-[36px] rounded-[var(--radius-art-sm)]" />
          case 'title':
            return <Skeleton key={id} className="h-[12px] w-[56%] rounded-[6px]" />
          case 'artist':
          case 'album':
            return <Skeleton key={id} tone="faint" className="h-[10px] w-[48%] rounded-[6px]" />
          default:
            return <span key={id} />
        }
      })}
    </div>
  )
}

export function RowsSkeleton({ columns }: { columns: TrackColumns }) {
  return (
    <div aria-busy="true" aria-label="Loading tracks" className="flex flex-col">
      {Array.from({ length: 12 }, (_, i) => (
        <RowSkeleton key={i} columns={columns} style={fade(i)} />
      ))}
    </div>
  )
}
