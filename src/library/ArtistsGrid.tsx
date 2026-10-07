import { useMemo } from 'react'
import { CoverArt } from '../ui/CoverArt'
import { formatCount, plural } from '../ui/format'
import { useGraph } from '../canvas/graphContext'
import { computeClusters } from '../canvas/clusters'

/* Artists: the same cover grid as albums, with round photos — on the map a
 * circle is an artist and a square a record, and the library keeps that.
 *
 * There is no artists endpoint; every artist is already in the graph the
 * map draws, with its records counted by the same cluster logic the map
 * uses, so this reads from that. A library's artists number in the
 * hundreds, not the tens of thousands albums can, so it isn't virtualised.
 * Artists with no records of their own (featured-only credits) are left
 * out: they'd fill the grid with names that lead nowhere. */

type ArtistsGridProps = {
  sortDir: 'asc' | 'desc'
  onOpen: (id: number) => void
}

export function ArtistsGrid({ sortDir, onOpen }: ArtistsGridProps) {
  const { nodes, edges } = useGraph()
  const artists = useMemo(() => {
    const { releasesOf } = computeClusters(nodes, edges)
    const list = nodes
      .filter((n) => n.type === 'artist' && (releasesOf.get(n.id)?.length ?? 0) > 0)
      .map((n) => ({ id: n.id, name: n.title, releases: releasesOf.get(n.id)?.length ?? 0 }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    return sortDir === 'asc' ? list : list.reverse()
  }, [nodes, edges, sortDir])

  return (
    <>
      <div className="mt-[28px] flex items-center justify-between">
        <h2 className="text-heading text-[var(--color-ink)]">All artists</h2>
        <span className="mono text-[length:var(--text-mono)] text-[var(--color-ink-2)]">{formatCount(artists.length)}</span>
      </div>
      <ul className="mt-[14px] grid grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-x-[24px] gap-y-[28px]">
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
