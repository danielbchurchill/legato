import { useMemo } from 'react'
import { CoverArt } from '../ui/CoverArt'
import { formatCount, plural } from '../ui/format'
import { useGraph } from '../canvas/graphContext'
import { libraryArtists } from './libraryArtists'
import { GridSkeleton } from './LibrarySkeleton'
import { LibraryEmpty } from './LibraryEmpty'
import { useLoadingWait } from './useLoadingWait'

/* Artists: the albums grid's tokens and rhythm, with round photos — on the
 * map a circle is an artist and a square a record, and the library keeps
 * that. LibraryStageV2 draws only albums and tracks, so this follows the
 * albums grid rather than a frame of its own.
 *
 * There is no artists endpoint; every artist is already in the graph the
 * map draws, so this reads from that, through libraryArtists (which also
 * gives the Library header its count). A library's artists number in the
 * hundreds, not the tens of thousands albums can, so it isn't virtualised. */

type ArtistsGridProps = {
  sortDir: 'asc' | 'desc'
  onOpen: (id: number) => void
}

export function ArtistsGrid({ sortDir, onOpen }: ArtistsGridProps) {
  const { nodes, edges, loading } = useGraph()
  const wait = useLoadingWait(loading)
  const artists = useMemo(() => {
    const list = libraryArtists(nodes, edges)
    return sortDir === 'asc' ? list : list.reverse()
  }, [nodes, edges, sortDir])

  if (loading) return wait.visible ? <GridSkeleton round label="Loading artists" /> : null
  if (artists.length === 0) return <LibraryEmpty title="No artists yet" body="Tracks without an artist tag are listed under tracks." />

  return (
    <>
      <div className="mt-[28px] flex items-center justify-between">
        <h2 className="text-heading text-[var(--color-ink)]">All artists</h2>
        <span className="mono text-mono text-[var(--color-ink-2)]">{formatCount(artists.length)}</span>
      </div>
      <ul className="mt-[14px] grid grid-cols-[repeat(auto-fill,minmax(var(--library-cell-min),1fr))] gap-x-[var(--library-column-gap)] gap-y-[var(--library-row-gap)]">
        {artists.map((artist) => (
          <li key={artist.id}>
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
                <span
                  title={artist.name}
                  className="truncate text-[length:var(--text-body)] leading-[20px] font-medium text-[var(--color-ink)]"
                >
                  {artist.name}
                </span>
                <span className="text-small text-[var(--color-ink-2)]">{plural(artist.releases, 'album')}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </>
  )
}
