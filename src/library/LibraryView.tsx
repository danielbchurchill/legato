import { useMemo, useRef, useState } from 'react'
import { Tabs } from '../ui/Tabs'
import { ScrollArea } from '../ui/ScrollArea'
import { plural } from '../ui/format'
import { useGraph } from '../canvas/graphContext'
import { useShellLayout } from '../shell/layout'
import type { usePlayback } from '../playback/usePlayback'
import type { Settings } from '../hooks/useSettings'
import { AlbumsGrid } from './AlbumsGrid'
import { ArtistsGrid } from './ArtistsGrid'
import { libraryArtists } from './libraryArtists'
import { TracksTable } from './TracksTable'
import { SortPill, type SortKind } from './SortPill'
import { ALBUM_SORT_OPTIONS, TRACK_SORT_OPTIONS, type AlbumSort, type SortDir, type TrackSort } from './types'

/* The library: the map's other view of the same music, as covers and rows.
 * Issue #126's map/library switch, now in the capsule.
 *
 * It takes over the stage between the side panels, so a panel opening
 * narrows it rather than covering it, and starts below the capsule. One
 * scroll area holds the header and whichever layout is showing; its last
 * 120px fade out under the player, so rows slide away beneath the glass
 * instead of being cut off by it.
 *
 * Opening anything here — a cover, a row, an artist — opens its details in
 * the right panel: there's no node card to show off the map. */

export type LibraryEntity = 'albums' | 'artists' | 'tracks'

const ENTITIES = [
  { value: 'albums', label: 'albums' },
  { value: 'artists', label: 'artists' },
  { value: 'tracks', label: 'tracks' },
] as const satisfies readonly { value: LibraryEntity; label: string }[]

const ARTIST_SORT = [{ id: 'name', label: 'name' }] as const

const ALBUM_KIND: Record<AlbumSort, SortKind> = { artist: 'text', title: 'text', year: 'number', dateAdded: 'date', recentlyPlayed: 'date' }
const TRACK_KIND: Record<TrackSort, SortKind> = {
  title: 'text',
  artist: 'text',
  album: 'text',
  duration: 'number',
  format: 'text',
  dateAdded: 'date',
}

type LibraryViewProps = {
  selectedNodeId: number | null
  onOpenNode: (id: number) => void
  playback: ReturnType<typeof usePlayback>
  settings: Settings
  updateSettings: (partial: Settings) => Promise<void>
}

export function LibraryView({ onOpenNode, playback, settings, updateSettings }: LibraryViewProps) {
  const layout = useShellLayout()
  const { nodes, edges, loading } = useGraph()
  const scrollRef = useRef<HTMLDivElement>(null)
  // The layout persists like the map/library switch itself; the sort is a
  // passing choice and resets with the view.
  const entity = (settings.libraryEntity as LibraryEntity) || 'albums'
  const [albumSort, setAlbumSort] = useState<{ sort: AlbumSort; dir: SortDir }>({ sort: 'artist', dir: 'asc' })
  const [trackSort, setTrackSort] = useState<{ sort: TrackSort; dir: SortDir }>({ sort: 'title', dir: 'asc' })
  const [artistDir, setArtistDir] = useState<SortDir>('asc')

  const counts = useMemo(() => {
    const byType = { release: 0, recording: 0 }
    for (const node of nodes) if (node.type in byType) byType[node.type as keyof typeof byType]++
    // The artists the Artists tab lists, not every artist node: featured-only
    // credits aren't in the tab, so they aren't in the count either.
    return { ...byType, artist: libraryArtists(nodes, edges).length }
  }, [nodes, edges])
  const empty = !loading && nodes.length === 0

  const scrollToTop = () => scrollRef.current?.scrollTo({ top: 0 })

  return (
    <div
      className="absolute inset-y-0 [mask-image:linear-gradient(to_bottom,#000_calc(100%-120px),transparent)]"
      style={{ left: layout.leftOccupancy, right: layout.rightOccupancy }}
    >
      <ScrollArea viewportRef={scrollRef} className="h-full" contentClassName="px-[32px] pt-[88px] pb-[160px]">
        {empty ? (
          // A folder is set but nothing has been matched yet: the first
          // scan is still running, or the folder holds nothing Legato reads.
          <div className="mx-auto mt-[120px] flex max-w-[440px] flex-col items-center gap-[10px] text-center">
            <h1 className="text-title text-[var(--color-ink)]">Nothing here yet</h1>
            <p className="text-[length:var(--text-secondary)] leading-[18px] text-[var(--color-ink-2)]">
              Albums appear as your folders are read. If a scan has finished and this is still empty, check the folder in Settings.
            </p>
          </div>
        ) : (
          <>
            <header className="flex flex-wrap items-end justify-between gap-[24px]">
              <div className="flex flex-col gap-[4px]">
                <h1 className="text-display text-[var(--color-ink)]">Library</h1>
                <span className="text-[length:var(--text-secondary)] leading-[18px] text-[var(--color-ink-2)]">
                  {loading
                    ? 'Loading…'
                    : `${plural(counts.release, 'album')} · ${plural(counts.artist, 'artist')} · ${plural(counts.recording, 'track')}`}
                </span>
              </div>
              <div className="flex items-center gap-[10px]">
                <Tabs
                  label="library layout"
                  size="md"
                  options={ENTITIES}
                  value={entity}
                  onChange={(value) => {
                    scrollToTop()
                    void updateSettings({ libraryEntity: value })
                  }}
                />
                {entity === 'albums' && (
                  <SortPill
                    options={ALBUM_SORT_OPTIONS}
                    value={albumSort.sort}
                    dir={albumSort.dir}
                    kindOf={(id) => ALBUM_KIND[id]}
                    onChange={(sort, dir) => setAlbumSort({ sort, dir })}
                  />
                )}
                {entity === 'tracks' && (
                  <SortPill
                    options={TRACK_SORT_OPTIONS}
                    value={trackSort.sort}
                    dir={trackSort.dir}
                    kindOf={(id) => TRACK_KIND[id]}
                    onChange={(sort, dir) => setTrackSort({ sort, dir })}
                  />
                )}
                {entity === 'artists' && (
                  <SortPill
                    options={ARTIST_SORT}
                    value="name"
                    dir={artistDir}
                    kindOf={() => 'text'}
                    onChange={(_, dir) => setArtistDir(dir)}
                  />
                )}
              </div>
            </header>

            {entity === 'albums' && (
              <AlbumsGrid
                scrollRef={scrollRef}
                sort={albumSort.sort}
                dir={albumSort.dir}
                onOpen={onOpenNode}
                onPlay={(id) => void playback.playAlbum(id)}
                onShowRecent={() => {
                  scrollToTop()
                  setAlbumSort({ sort: 'dateAdded', dir: 'desc' })
                }}
              />
            )}
            {entity === 'artists' && <ArtistsGrid sortDir={artistDir} onOpen={onOpenNode} />}
            {entity === 'tracks' && (
              <TracksTable
                scrollRef={scrollRef}
                sort={trackSort.sort}
                dir={trackSort.dir}
                onSort={(sort, dir) => setTrackSort({ sort, dir })}
                playingId={playback.status.currentRecordingNodeId}
                playing={playback.status.playing}
                onOpen={onOpenNode}
                onPlay={(track) => void playback.playNode(track.id, track.title)}
              />
            )}
          </>
        )}
      </ScrollArea>
    </div>
  )
}
