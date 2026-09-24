import { useEffect, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { CoverArt } from '../ui/CoverArt'
import { ScrollingText } from '../ui/ScrollingText'
import { useLibraryPage } from './useLibraryPage'
import type { AlbumRow, AlbumSort, SortDir } from './types'

// There's no Figma frame for this view yet (issue #126 shipped ahead of the
// design pass — same footing DESIGN.md already documents for Database
// Inspector/Favourites/Tag Manager). These are reasoned, not measured:
// CELL_WIDTH is sized to read a 256px cover comfortably at the panel widths
// --panel-width already settles on around the 1440px reference, and the two
// text-line figures mirror DataRow/SectionHeader's own `leading-[24px]`
// rhythm rather than inventing a new one. Kept as named constants, not
// scattered literals, specifically so the geometry has one place to correct
// once a real frame exists.
const CELL_WIDTH = 160
const CELL_GAP = 20 // --spacing-lg
const COVER_GAP = 5 // --spacing-xs, between the cover and its title/artist
const TEXT_LINE_HEIGHT = 24 // matches DataRow/SectionHeader's leading-[24px]
const ROW_GAP = 10 // --spacing-sm, between one row of albums and the next
const ROW_HEIGHT = CELL_WIDTH + COVER_GAP + TEXT_LINE_HEIGHT * 2 + ROW_GAP
const PADDING = 20 // --spacing-lg, matches the panel's own side padding rhythm

type AlbumsGridProps = {
  query: string
  sort: AlbumSort
  dir: SortDir
  onSelectNode: (id: number) => void
}

// Selecting a cell only selects+flies — it doesn't also play (no
// PlayNodeButton here). Out of the issue's "Done when" list (the plan
// spec's grid is cover/title/artist/sort, nothing about a transport
// affordance per cell), so it's left as a documented follow-up rather than
// added speculatively: the map's own NodeCard already covers play-on-select
// once a node picked here is flown to.
function AlbumCell({ album, onSelectNode }: { album: AlbumRow; onSelectNode: (id: number) => void }) {
  return (
    <button
      type="button"
      onClick={() => onSelectNode(album.id)}
      className="flex flex-col text-left"
      style={{ width: CELL_WIDTH }}
    >
      <CoverArt
        nodeId={album.id}
        size="thumb"
        className="shrink-0 rounded-[var(--radius-control)]"
        alt={album.title}
        style={{ width: CELL_WIDTH, height: CELL_WIDTH }}
      />
      {/* Title and artist: both Sometype Mono ink, no muted label — same as
       * NodeHoverPlate's title+subtitle pair. Position (which line is
       * first) carries the meaning here, not color, since there's no
       * "artist:" label to mute against a value the way DataRow's
       * panel-list rows have one. */}
      <div style={{ marginTop: COVER_GAP }}>
        <ScrollingText
          text={album.title}
          className="block font-[family-name:var(--font-mono)] text-[length:var(--text-base)] leading-[24px] text-[var(--color-ink)]"
        />
        {album.artistName && (
          <ScrollingText
            text={album.artistName}
            className="block font-[family-name:var(--font-mono)] text-[length:var(--text-base)] leading-[24px] text-[var(--color-ink)]"
          />
        )}
      </div>
    </button>
  )
}

/** Album cover grid (issue #126, D11). Virtualized by row, not by cell — see
 * DESIGN.md "Library view" for why: @tanstack/react-virtual has no built-in
 * notion of a wrapping grid, only a linear list of items with a size, so a
 * "row" here is one virtual item containing `columnCount` cells, and
 * `columnCount` itself is recomputed from the container's measured width
 * (ResizeObserver) rather than fixed, since --panel-width already makes the
 * canvas area between the two side panels a variable width today.
 *
 * Data loads in the same windowed, incremental way the DOM virtualizes:
 * useLibraryPage only fetches the pages the currently visible row range
 * actually touches, which is the other half (alongside DOM virtualization)
 * of staying smooth at 30k albums — see that hook's own comment. */
export function AlbumsGrid({ query, sort, dir, onSelectNode }: AlbumsGridProps) {
  const parentRef = useRef<HTMLDivElement>(null)
  const [columnCount, setColumnCount] = useState(1)
  const { rows, total, ensureRange } = useLibraryPage<AlbumRow>('library/albums', query, sort, dir)

  useEffect(() => {
    const el = parentRef.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width - PADDING * 2
      setColumnCount(Math.max(1, Math.floor((width + CELL_GAP) / (CELL_WIDTH + CELL_GAP))))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const rowCount = Math.ceil(total / columnCount)
  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT + ROW_GAP,
    overscan: 3,
  })

  const virtualRows = rowVirtualizer.getVirtualItems()
  const firstIndex = virtualRows[0]?.index
  const lastIndex = virtualRows[virtualRows.length - 1]?.index
  useEffect(() => {
    if (firstIndex == null || lastIndex == null) return
    ensureRange(firstIndex * columnCount, Math.min(total - 1, (lastIndex + 1) * columnCount - 1))
  }, [firstIndex, lastIndex, columnCount, total, ensureRange])

  if (total === 0 && rows.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-[length:var(--text-base)] text-[var(--color-muted)]">
          {query ? `no albums match "${query}"` : 'no albums yet'}
        </p>
      </div>
    )
  }

  return (
    <div ref={parentRef} className="relative h-full overflow-y-auto">
      <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
        {virtualRows.map((virtualRow) => {
          const rowStart = virtualRow.index * columnCount
          return (
            <div
              key={virtualRow.key}
              className="absolute top-0 left-0 flex w-full"
              style={{ transform: `translateY(${virtualRow.start}px)`, gap: CELL_GAP, padding: `0 ${PADDING}px` }}
            >
              {Array.from({ length: columnCount }, (_, col) => {
                const index = rowStart + col
                if (index >= total) return null
                const album = rows[index]
                return album ? (
                  <AlbumCell key={album.id} album={album} onSelectNode={onSelectNode} />
                ) : (
                  <div key={index} aria-hidden className="shrink-0 rounded-[var(--radius-control)] bg-[var(--color-placeholder)]" style={{ width: CELL_WIDTH, height: CELL_WIDTH }} />
                )
              })}
            </div>
          )
        })}
      </div>
    </div>
  )
}
