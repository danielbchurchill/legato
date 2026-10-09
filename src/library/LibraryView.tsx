import { useCallback, useRef, useState, type ReactNode } from 'react'
import { Tabs } from '../ui/Tabs'
import { Button } from '../ui/Button'
import { ScrollArea } from '../ui/ScrollArea'
import { plural } from '../ui/format'
import { useGraph } from '../canvas/graphContext'
import { useShellLayout } from '../shell/layout'
import { useScanStatus } from '../hooks/useScanStatus'
import { useLibraryChanges, useLibraryStats } from './useLibraryChanges'
import type { usePlayback } from '../playback/usePlayback'
import type { Settings } from '../hooks/useSettings'
import { AlbumsGrid } from './AlbumsGrid'
import { ArtistsGrid } from './ArtistsGrid'
import { TracksTable } from './TracksTable'
import { LibraryEmpty } from './LibraryEmpty'
import { SortPill, type SortKind } from './SortPill'
import { ALBUM_SORT_OPTIONS, TRACK_SORT_OPTIONS, type AlbumSort, type SortDir, type TrackRow, type TrackSort } from './types'

/* The library: the map's other view of the same music, as covers and rows.
 * Issue #126's map/library switch, now in the capsule; laid out from
 * LibraryStageV2, the v2 handoff's library frame (#263).
 *
 * It takes over the stage between the side panels (the shell's left and
 * right occupancy), so a panel opening narrows it and the grid reflows,
 * rather than the panel covering it. One scroll area holds the header and
 * whichever layout is showing, inset 88px from the top (the capsule's 60px
 * and 28px under it) and 32px each side, as the frame insets it. Its last
 * 120px fade out under the player, so rows slide away beneath the glass
 * instead of being cut off by it, and 160px of padding below the last row
 * lets it come to rest above that fade.
 *
 * The header stays in every state, as the frame keeps it: the counts line
 * reads "Loading…" or "Nothing here yet" while there's nothing to count.
 * The counts are GET /stats's, Library health's numbers, counted on the
 * server over the whole library (#302). The map's graph stops at 5,000
 * nodes, so counting it said "455 albums · 0 artists" at 30,000 albums.
 * They show as soon as /stats answers, without waiting for the graph, and
 * they and the Artists tab are fetched again together when the library
 * changes (useLibraryChanges).
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
  /** No music folder yet: the frame's first-run state, this in place of a
   * layout under the header. */
  firstRun?: ReactNode
}

export function LibraryView({ onOpenNode, playback, settings, updateSettings, firstRun }: LibraryViewProps) {
  const layout = useShellLayout()
  const { nodes, loading } = useGraph()
  const revision = useLibraryChanges()
  const stats = useLibraryStats(revision)
  const scan = useScanStatus()
  const scrollRef = useRef<HTMLDivElement>(null)
  // The layout persists like the map/library switch itself; the sort is a
  // passing choice and resets with the view.
  const entity = (settings.libraryEntity as LibraryEntity) || 'albums'
  const [albumSort, setAlbumSort] = useState<{ sort: AlbumSort; dir: SortDir }>({ sort: 'artist', dir: 'asc' })
  const [trackSort, setTrackSort] = useState<{ sort: TrackSort; dir: SortDir }>({ sort: 'title', dir: 'asc' })
  const [artistDir, setArtistDir] = useState<SortDir>('asc')

  // A folder is set but nothing has been matched yet: the first scan is
  // still running, or the folder holds nothing Legato reads. The graph's
  // cap doesn't matter here: a graph with any node is a library with one.
  // /stats can't say this. Its tracks count files as the scan reads them,
  // and the graph and the albums only fill at the scan's recompute, so
  // partway through a first scan /stats has tracks and the albums grid has
  // nothing, where this still reads "Reading your library".
  const empty = firstRun == null && !loading && nodes.length === 0

  const scrollToTop = () => scrollRef.current?.scrollTo({ top: 0 })
  // Stable, so the grid's memoised cells don't re-render when playback
  // ticks this view over.
  const { playAlbum, playNode } = playback
  const onPlayAlbum = useCallback((id: number) => void playAlbum(id), [playAlbum])
  const onPlayTrack = useCallback((track: TrackRow) => void playNode(track.id, track.title), [playNode])

  return (
    <div
      className="absolute inset-y-0 [mask-image:linear-gradient(to_bottom,#000_calc(100%-120px),transparent)]"
      style={{ left: layout.leftOccupancy, right: layout.rightOccupancy }}
    >
      <ScrollArea viewportRef={scrollRef} className="h-full" contentClassName="px-[32px] pt-[88px] pb-[160px]">
        <header className="flex flex-wrap items-end justify-between gap-[24px]">
          <div className="flex flex-col gap-[4px]">
            <h1 className="text-display text-[var(--color-ink)]">Library</h1>
            <span className="text-[length:var(--text-secondary)] leading-[18px] text-[var(--color-ink-2)]">
              {firstRun != null || empty
                ? 'Nothing here yet'
                : !stats
                  ? 'Loading…'
                  : `${plural(stats.albums, 'album')} · ${plural(stats.artists, 'artist')} · ${plural(stats.tracks, 'track')}`}
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
              <SortPill options={ARTIST_SORT} value="name" dir={artistDir} kindOf={() => 'text'} onChange={(_, dir) => setArtistDir(dir)} />
            )}
          </div>
        </header>

        {firstRun ??
          (empty ? (
            scan.scanning ? (
              <LibraryEmpty title="Reading your library" body="Albums appear here as tracks are matched." />
            ) : scan.error ? (
              // The map's own words for a failed scan (MapNotice in Canvas).
              <LibraryEmpty title="The scan stopped" body={scan.error}>
                <Button variant="primary" onClick={scan.retry}>
                  Try again
                </Button>
              </LibraryEmpty>
            ) : (
              <LibraryEmpty title="No music found" body="Legato couldn't read anything in your folders. Check them in Settings." />
            )
          ) : (
            <>
              {entity === 'albums' && (
                <AlbumsGrid
                  scrollRef={scrollRef}
                  sort={albumSort.sort}
                  dir={albumSort.dir}
                  onOpen={onOpenNode}
                  onPlay={onPlayAlbum}
                  onShowRecent={() => {
                    scrollToTop()
                    setAlbumSort({ sort: 'dateAdded', dir: 'desc' })
                  }}
                />
              )}
              {entity === 'artists' && <ArtistsGrid scrollRef={scrollRef} sortDir={artistDir} revision={revision} onOpen={onOpenNode} />}
              {entity === 'tracks' && (
                <TracksTable
                  scrollRef={scrollRef}
                  sort={trackSort.sort}
                  dir={trackSort.dir}
                  onSort={(sort, dir) => setTrackSort({ sort, dir })}
                  playingId={playback.status.currentRecordingNodeId}
                  playing={playback.status.playing}
                  onOpen={onOpenNode}
                  onPlay={onPlayTrack}
                />
              )}
            </>
          ))}
      </ScrollArea>
    </div>
  )
}
