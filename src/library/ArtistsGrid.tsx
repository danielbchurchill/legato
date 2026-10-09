import { memo, type RefObject } from 'react'
import { CoverArt } from '../ui/CoverArt'
import { formatCount, plural } from '../ui/format'
import { useLibraryPage } from './useLibraryPage'
import { useCoverGrid } from './useCoverGrid'
import { CellSkeleton, GridSkeleton } from './LibrarySkeleton'
import { LibraryEmpty } from './LibraryEmpty'
import type { ArtistRow, SortDir } from './types'

/* Artists: the albums grid's tokens and rhythm, with round photos — on the
 * map a circle is an artist and a square a record, and the library keeps
 * that. LibraryStageV2 draws only albums and tracks, so this follows the
 * albums grid rather than a frame of its own.
 *
 * Every artist with records of its own, paged from GET /library/artists and
 * virtualised as the albums grid is (#302). That route's rule is the one
 * GET /stats counts for the Library header, so the header and this grid
 * can't disagree. They used to read the map's graph, which stops at 5,000
 * nodes: at 30,000 albums the grid was empty. */

type ArtistsGridProps = {
  scrollRef: RefObject<HTMLDivElement | null>
  sortDir: SortDir
  onOpen: (id: number) => void
}

/* A round photo with the name and album count under it. On hover the photo
 * lifts 3px into --shadow-panel. Memoised, with the grid's own onOpen, for
 * the reason AlbumCell is: the virtualiser re-renders the grid on every
 * scroll event. */
const ArtistCell = memo(function ArtistCell({ artist, onOpen }: { artist: ArtistRow; onOpen: (id: number) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(artist.id)}
      className="group flex w-full min-w-0 flex-col items-center gap-[10px] text-center"
    >
      <CoverArt
        nodeId={artist.id}
        size="thumb"
        radius="round"
        alt=""
        className="aspect-square w-full transition-[transform,box-shadow] duration-[var(--motion-base)] ease-[var(--ease-out)] group-hover:-translate-y-[3px] group-hover:shadow-[var(--shadow-panel)]"
      />
      <span className="flex w-full min-w-0 flex-col">
        <span title={artist.name} className="truncate text-[length:var(--text-body)] leading-[20px] font-medium text-[var(--color-ink)]">
          {artist.name}
        </span>
        <span className="text-small text-[var(--color-ink-2)]">{plural(artist.releases, 'album')}</span>
      </span>
    </button>
  )
})

export function ArtistsGrid({ scrollRef, sortDir, onOpen }: ArtistsGridProps) {
  const { rows, total, loading, waitVisible, ensureRange } = useLibraryPage<ArtistRow>('library/artists', '', 'name', sortDir)
  const { gridRef, columns, items, height, scrollMargin } = useCoverGrid({ scrollRef, total, loading, ensureRange })

  if (loading) return waitVisible ? <GridSkeleton round label="Loading artists" /> : null
  if (total === 0) return <LibraryEmpty title="No artists yet" body="Tracks without an artist tag are listed under tracks." />

  return (
    <>
      <div className="mt-[28px] flex items-center justify-between">
        <h2 className="text-heading text-[var(--color-ink)]">All artists</h2>
        <span className="mono text-mono text-[var(--color-ink-2)]">{formatCount(total)}</span>
      </div>
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
                const artist = rows[index]
                return artist ? (
                  <ArtistCell key={artist.id} artist={artist} onOpen={onOpen} />
                ) : (
                  <CellSkeleton key={`pending-${index}`} round />
                )
              })}
            </div>
          )
        })}
      </div>
    </>
  )
}
