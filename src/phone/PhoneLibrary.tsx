import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Button } from '../ui/Button'
import { Chip } from '../ui/Chip'
import { CoverArt } from '../ui/CoverArt'
import { Icon } from '../ui/Icon'
import { Skeleton } from '../ui/Skeleton'
import { NO_VALUE, formatDuration, plural } from '../ui/format'
import { useGraph } from '../canvas/graphContext'
import { useScanStatus } from '../hooks/useScanStatus'
import { CoverGrid } from '../library/CoverGrid'
import { CellSkeleton } from '../library/LibrarySkeleton'
import { LibraryEmpty } from '../library/LibraryEmpty'
import { SortPill } from '../library/SortPill'
import { useLibraryChanges } from '../library/useLibraryChanges'
import { useLibraryPage } from '../library/useLibraryPage'
import {
  ALBUM_SORT_KIND,
  ALBUM_SORT_OPTIONS,
  TRACK_SORT_KIND,
  TRACK_SORT_OPTIONS,
  directionLabel,
  type AlbumRow,
  type AlbumSort,
  type ArtistRow,
  type CreditRow,
  type SortDir,
  type SortKind,
  type TrackRow,
  type TrackSort,
} from '../library/types'
import type { usePlayback } from '../playback/usePlayback'

/* The phone's library tab (#389, Legato Mobile v2 screen 2), in the sheet
 * at its large detent: chips for albums, artists, tracks and credits, a
 * sort line naming the order, and the layout under them.
 *
 * The same library the desktop's view pages through (useLibraryPage, the
 * GET /library/* routes) and the same virtualised cover grid (CoverGrid),
 * at the handoff's two columns. Tracks and credits are rows, as the
 * handoff's search results draw a track and a person.
 *
 * The chips and the sort line stay put and the layout scrolls under them,
 * in a scroller of its own. That's what lets the sheet tell a scroll from
 * a drag (Sheet.tsx): a drag down on the layout scrolls it until it's back
 * at its top, and only then moves the sheet. The tab is laid over the
 * sheet's whole body, under the home indicator too, so the layout scrolls
 * to the bottom edge, as the handoff's frame cuts its covers off there.
 *
 * Opening an album, an artist or a person selects it the way the map does
 * (PhoneShell's onOpenNode). A track plays: tapping a row is how a phone
 * plays a song. */

export type PhoneLibraryEntity = 'albums' | 'artists' | 'tracks' | 'credits'

const ENTITIES: readonly PhoneLibraryEntity[] = ['albums', 'artists', 'tracks', 'credits']

/* Under a grid cover, from the frame: 8px, then a 19px title line and a
 * 16px artist line. */
const CELL_TEXT = 8 + 19 + 16
/* The frame's rows: a track as the search results draw one, 52px with a
 * 40px cover; a person 60px with a 48px avatar. */
const TRACK_ROW = 52
const PERSON_ROW = 60

/* The frame's grid gaps: 16px between rows, 14px between the columns. The
 * desktop's --library-* gaps, set for this grid alone. */
const GRID_GAPS = { '--library-row-gap': '16px', '--library-column-gap': '14px' } as CSSProperties

/* A 36px button's 44px target. */
const TARGET = "relative before:absolute before:inset-x-0 before:-inset-y-[4px] before:content-['']"

/* Artists and people sort by name alone, as the desktop's artists do. */
const BY_NAME = [{ id: 'name', label: 'name' }] as const

type Playback = ReturnType<typeof usePlayback>

type PhoneLibraryProps = {
  onOpenNode: (id: number) => void
  playback: Playback
  /** No music folder yet: the map shows first run's "Add your music". */
  noLibrary: boolean
  /** Back to the map, where "Add your music" is. */
  onShowMap: () => void
}

export function PhoneLibrary({ onOpenNode, playback, noLibrary, onShowMap }: PhoneLibraryProps) {
  const { nodes, loading } = useGraph()
  const scan = useScanStatus()
  const [entity, setEntity] = useState<PhoneLibraryEntity>('albums')

  // DESIGN.md's library states, in the desktop library's words: a folder
  // whose scan hasn't matched anything yet has no map either.
  const empty = !noLibrary && !loading && nodes.length === 0
  if (noLibrary || empty) {
    return (
      <div className="absolute inset-0 overflow-y-auto overscroll-contain px-[20px]">
        {noLibrary ? (
          <LibraryEmpty title="Nothing here yet" body="Add a folder of music and your albums, artists and tracks collect here.">
            <Button variant="primary" size="lg" icon="add" onClick={onShowMap} className={TARGET}>
              Add your music
            </Button>
          </LibraryEmpty>
        ) : scan.scanning ? (
          <LibraryEmpty title="Reading your library" body="Albums appear here as tracks are matched." />
        ) : scan.error ? (
          <LibraryEmpty title="The scan stopped" body={scan.error}>
            <Button variant="primary" size="lg" onClick={scan.retry} className={TARGET}>
              Try again
            </Button>
          </LibraryEmpty>
        ) : (
          <LibraryEmpty title="No music found" body="Legato couldn't read anything in your folders. Check them in Settings." />
        )}
      </div>
    )
  }

  return (
    <div className="absolute inset-0 flex flex-col">
      {/* A row that scrolls sideways if a narrow phone can't fit all four,
       * padded so each chip's 44px target isn't clipped. The frame's row is
       * 14px under the tabs and 34px tall, its outlined chips' borders
       * outside their 32px, so the chips sit 1px into it. */}
      <div role="group" aria-label="Show" className="scrollbar-none flex shrink-0 gap-[6px] overflow-x-auto px-[16px] pt-[15px] pb-[7px]">
        {ENTITIES.map((value) => (
          <Chip key={value} size="lg" active={value === entity} onClick={() => setEntity(value)}>
            {value}
          </Chip>
        ))}
      </div>
      {entity === 'albums' && <Albums onOpen={onOpenNode} />}
      {entity === 'artists' && <Artists onOpen={onOpenNode} />}
      {entity === 'tracks' && <Tracks playback={playback} />}
      {entity === 'credits' && <Credits onOpen={onOpenNode} />}
    </div>
  )
}

/* "312 albums · recently added", with the sort glyph at the end, as the
 * frame draws it. The line opens the desktop's sort list (SortPill), and
 * choosing the active order again flips it, as there. Its target reaches
 * 6px up, to meet the chips' own, and 20px down into the layout's top, so
 * it's 44px tall without taking any of theirs. */
function SortLine<T extends string>({
  count,
  options,
  value,
  dir,
  kindOf,
  onChange,
}: {
  count: string
  options: readonly { id: T; label: string }[]
  value: T
  dir: SortDir
  kindOf: (id: T) => SortKind
  onChange: (value: T, dir: SortDir) => void
}) {
  const label = options.find((o) => o.id === value)?.label ?? ''
  const text = `${count} · ${orderWords(label, kindOf(value), dir)}`
  return (
    <div className="flex shrink-0 px-[20px] pt-[6px]">
      <SortPill
        large
        options={options}
        value={value}
        dir={dir}
        kindOf={kindOf}
        onChange={onChange}
        trigger={({ open, ...props }) => (
          <button
            type="button"
            {...props}
            aria-label={`Sort: ${text}`}
            className={`relative z-[1] flex h-[18px] w-full items-center justify-between gap-[12px] text-small before:absolute before:inset-x-0 before:-top-[6px] before:-bottom-[20px] before:content-[''] ${
              open ? 'text-[var(--color-ink)]' : 'text-[var(--color-ink-2)]'
            }`}
          >
            <span className="truncate">{text}</span>
            <Icon name="filter" size={18} className="shrink-0" />
          </button>
        )}
      />
    </div>
  )
}

/* The words for an order. Newest first by date added is "recently added",
 * as the frame says it. */
function orderWords(label: string, kind: SortKind, dir: SortDir): string {
  if (kind === 'date' && dir === 'desc') return label === 'date added' ? 'recently added' : label
  return `${label} ${directionLabel(kind, dir)}`
}

/* The layout's scroller, under the sort line. Its 12px top padding is the
 * frame's; the bottom clears the home indicator and a little more. */
function Scroller({ scrollRef, label, children }: { scrollRef: RefObject<HTMLDivElement | null>; label: string; children: ReactNode }) {
  return (
    <div
      ref={scrollRef}
      aria-label={label}
      className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-[16px] pt-[12px] pb-[calc(env(safe-area-inset-bottom)+24px)]"
    >
      {children}
    </div>
  )
}

/* Loading, past the first 400ms: six cells in the grid's own shape. */
function GridLoading({ round = false, label }: { round?: boolean; label: string }) {
  return (
    <div aria-busy="true" aria-label={label} className="grid grid-cols-2 gap-x-[14px] gap-y-[16px]">
      {Array.from({ length: 6 }, (_, i) => (
        <CellSkeleton key={i} round={round} style={{ opacity: Math.max(0.25, 1 - i * 0.12) }} />
      ))}
    </div>
  )
}

/* ---- Albums ----------------------------------------------------------- */

/* A cover, its title and its artist, as the frame draws a cell. Memoised,
 * with the grid's own onOpen, as the desktop's cells are: the virtualiser
 * re-renders the grid on every scroll event. */
const AlbumCell = memo(function AlbumCell({ album, onOpen }: { album: AlbumRow; onOpen: (id: number) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(album.id)}
      aria-label={`${album.title}${album.artistName ? `, ${album.artistName}` : ''}`}
      className="flex w-full min-w-0 flex-col gap-[8px] text-left"
    >
      <CoverArt nodeId={album.id} size="thumb" radius="none" className="aspect-square w-full rounded-[8px]" />
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-[length:var(--text-body)] leading-[19px] font-medium text-[var(--color-ink)]">{album.title}</span>
        <span className="truncate text-small text-[var(--color-ink-2)]">{album.artistName ?? NO_VALUE}</span>
      </span>
    </button>
  )
})

function Albums({ onOpen }: { onOpen: (id: number) => void }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  // The frame's order: newest first.
  const [sort, setSort] = useState<{ sort: AlbumSort; dir: SortDir }>({ sort: 'dateAdded', dir: 'desc' })
  const { rows, total, loading, waitVisible, ensureRange } = useLibraryPage<AlbumRow>('library/albums', '', sort.sort, sort.dir)

  return (
    <>
      <SortLine
        count={loading ? 'albums' : plural(total, 'album')}
        options={ALBUM_SORT_OPTIONS}
        value={sort.sort}
        dir={sort.dir}
        kindOf={(id) => ALBUM_SORT_KIND[id]}
        onChange={(next, dir) => {
          scrollRef.current?.scrollTo({ top: 0 })
          setSort({ sort: next, dir })
        }}
      />
      <Scroller scrollRef={scrollRef} label="Albums">
        {loading ? (
          waitVisible && <GridLoading label="Loading albums" />
        ) : total === 0 ? (
          <LibraryEmpty title="No albums yet" body="Tracks without an album tag are listed under tracks." />
        ) : (
          <div style={GRID_GAPS}>
            <CoverGrid
              scrollRef={scrollRef}
              rows={rows}
              total={total}
              ensureRange={ensureRange}
              columns={2}
              textBlock={CELL_TEXT}
              className=""
              renderCell={(album) => <AlbumCell album={album} onOpen={onOpen} />}
            />
          </div>
        )}
      </Scroller>
    </>
  )
}

/* ---- Artists ---------------------------------------------------------- */

/* The frame draws no artists. They take the albums' cell with a round
 * photo, as the desktop's grid does: on the map a circle is an artist. */
const ArtistCell = memo(function ArtistCell({ artist, onOpen }: { artist: ArtistRow; onOpen: (id: number) => void }) {
  return (
    <button type="button" onClick={() => onOpen(artist.id)} className="flex w-full min-w-0 flex-col items-center gap-[8px] text-center">
      <CoverArt nodeId={artist.id} size="thumb" radius="round" alt="" className="aspect-square w-full" />
      <span className="flex w-full min-w-0 flex-col">
        <span className="truncate text-[length:var(--text-body)] leading-[19px] font-medium text-[var(--color-ink)]">{artist.name}</span>
        <span className="truncate text-small text-[var(--color-ink-2)]">{plural(artist.releases, 'album')}</span>
      </span>
    </button>
  )
})

function Artists({ onOpen }: { onOpen: (id: number) => void }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const revision = useLibraryChanges()
  const [dir, setDir] = useState<SortDir>('asc')
  const { rows, total, loading, waitVisible, ensureRange } = useLibraryPage<ArtistRow>('library/artists', '', 'name', dir, revision)

  return (
    <>
      <SortLine
        count={loading ? 'artists' : plural(total, 'artist')}
        options={BY_NAME}
        value="name"
        dir={dir}
        kindOf={() => 'text'}
        onChange={(_, next) => {
          scrollRef.current?.scrollTo({ top: 0 })
          setDir(next)
        }}
      />
      <Scroller scrollRef={scrollRef} label="Artists">
        {loading ? (
          waitVisible && <GridLoading round label="Loading artists" />
        ) : total === 0 ? (
          <LibraryEmpty title="No artists yet" body="Tracks without an artist tag are listed under tracks." />
        ) : (
          <div style={GRID_GAPS}>
            <CoverGrid
              scrollRef={scrollRef}
              rows={rows}
              total={total}
              ensureRange={ensureRange}
              columns={2}
              textBlock={CELL_TEXT}
              round
              className=""
              renderCell={(artist) => <ArtistCell artist={artist} onOpen={onOpen} />}
            />
          </div>
        )}
      </Scroller>
    </>
  )
}

/* ---- Rows: tracks and credits ----------------------------------------- */

/* A virtualised list in the layout's scroller, paged as the grid is. Each
 * row sits at its own offset; a row whose page hasn't landed is a skeleton
 * of the same height, so nothing moves when it arrives. */
function PagedRows<Row>({
  scrollRef,
  label,
  rows,
  total,
  ensureRange,
  rowHeight,
  renderRow,
  pending,
}: {
  scrollRef: RefObject<HTMLDivElement | null>
  label: string
  rows: (Row | undefined)[]
  total: number
  ensureRange: (startIndex: number, endIndex: number) => void
  rowHeight: number
  renderRow: (row: Row) => ReactNode
  pending: ReactNode
}) {
  const listRef = useRef<HTMLDivElement>(null)
  const [offset, setOffset] = useState<number | null>(null)
  useLayoutEffect(() => {
    if (listRef.current) setOffset(listRef.current.offsetTop)
  }, [])

  const virtualizer = useVirtualizer({
    // Nothing until the list knows where it starts.
    count: offset == null ? 0 : total,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 8,
    scrollMargin: offset ?? 0,
  })
  const items = virtualizer.getVirtualItems()
  const firstIndex = items[0]?.index
  const lastIndex = items[items.length - 1]?.index
  useEffect(() => {
    if (firstIndex == null || lastIndex == null) return
    ensureRange(firstIndex, lastIndex)
  }, [firstIndex, lastIndex, ensureRange])

  return (
    <div ref={listRef} role="list" aria-label={label} className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
      {items.map((item) => {
        const row = rows[item.index]
        return (
          <div
            key={item.key}
            role="listitem"
            className="absolute top-0 left-0 w-full"
            style={{ height: rowHeight, transform: `translateY(${item.start - virtualizer.options.scrollMargin}px)` }}
          >
            {row ? renderRow(row) : pending}
          </div>
        )
      })}
    </div>
  )
}

function RowLoading({ size, round = false }: { size: number; round?: boolean }) {
  return (
    <div aria-hidden="true" className="flex h-full items-center gap-[12px] px-[4px]">
      <Skeleton className={`shrink-0 ${round ? 'rounded-full' : 'rounded-[5px]'}`} style={{ width: size, height: size }} />
      <span className="flex flex-1 flex-col gap-[6px]">
        <Skeleton className="h-[12px] w-[56%] rounded-[6px]" />
        <Skeleton tone="faint" className="h-[10px] w-[36%] rounded-[6px]" />
      </span>
    </div>
  )
}

function RowsLoading({ height, size, round, label }: { height: number; size: number; round?: boolean; label: string }) {
  return (
    <div aria-busy="true" aria-label={label} className="flex flex-col">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} style={{ height, opacity: Math.max(0.25, 1 - i * 0.1) }}>
          <RowLoading size={size} round={round} />
        </div>
      ))}
    </div>
  )
}

/* A track as the handoff's search results draw one: a 40px cover, the
 * title over the artist, the duration in mono. The row plays it, and says
 * so to a screen reader. The playing track's title is in the accent, as
 * the desktop's table marks it. */
const TrackRowView = memo(function TrackRowView({
  track,
  isPlaying,
  onPlay,
}: {
  track: TrackRow
  isPlaying: boolean
  onPlay: (track: TrackRow) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onPlay(track)}
      aria-label={`Play ${track.title}${track.artistName ? `, ${track.artistName}` : ''}`}
      aria-current={isPlaying ? 'true' : undefined}
      className="flex h-full w-full items-center gap-[12px] px-[4px] text-left"
    >
      <CoverArt nodeId={track.albumId ?? track.id} size="thumb" radius="none" className="size-[40px] rounded-[5px]" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={`truncate text-[15px] leading-[20px] ${isPlaying ? 'text-[var(--color-accent)]' : 'text-[var(--color-ink)]'}`}>
          {track.title}
        </span>
        <span className="truncate text-[length:var(--text-secondary)] leading-[18px] text-[var(--color-ink-2)]">
          {track.artistName ?? NO_VALUE}
        </span>
      </span>
      <span className="mono shrink-0 text-mono text-[var(--color-ink-2)]">{formatDuration(track.durationMs)}</span>
    </button>
  )
})

function Tracks({ playback }: { playback: Playback }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [sort, setSort] = useState<{ sort: TrackSort; dir: SortDir }>({ sort: 'title', dir: 'asc' })
  const { rows, total, loading, waitVisible, ensureRange } = useLibraryPage<TrackRow>('library/tracks', '', sort.sort, sort.dir)
  // Stable, so the memoised rows don't re-render as playback ticks.
  const { playNode } = playback
  const onPlay = useCallback((track: TrackRow) => void playNode(track.id, track.title), [playNode])
  const playingId = playback.status.currentRecordingNodeId

  return (
    <>
      <SortLine
        count={loading ? 'tracks' : plural(total, 'track')}
        options={TRACK_SORT_OPTIONS}
        value={sort.sort}
        dir={sort.dir}
        kindOf={(id) => TRACK_SORT_KIND[id]}
        onChange={(next, dir) => {
          scrollRef.current?.scrollTo({ top: 0 })
          setSort({ sort: next, dir })
        }}
      />
      <Scroller scrollRef={scrollRef} label="Tracks">
        {loading ? (
          waitVisible && <RowsLoading height={TRACK_ROW} size={40} label="Loading tracks" />
        ) : total === 0 ? (
          <LibraryEmpty title="No tracks yet" body="Tracks appear here as your folders are read." />
        ) : (
          <PagedRows
            scrollRef={scrollRef}
            label="Tracks"
            rows={rows}
            total={total}
            ensureRange={ensureRange}
            rowHeight={TRACK_ROW}
            pending={<RowLoading size={40} />}
            renderRow={(track) => <TrackRowView track={track} isPlaying={track.id === playingId} onPlay={onPlay} />}
          />
        )}
      </Scroller>
    </>
  )
}

/* A person as the handoff's search results draw one: a round avatar in the
 * map's credit colour, the name over what they did, and their track count
 * in mono. */
const PersonRow = memo(function PersonRow({ person, onOpen }: { person: CreditRow; onOpen: (id: number) => void }) {
  return (
    <button type="button" onClick={() => onOpen(person.id)} className="flex h-full w-full items-center gap-[12px] px-[4px] text-left">
      <span
        aria-hidden="true"
        className="size-[48px] shrink-0 rounded-full bg-[var(--color-node-credit)] shadow-[var(--shadow-art-edge)]"
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[15px] leading-[20px] font-medium text-[var(--color-ink)]">{person.name}</span>
        <span className="truncate text-[length:var(--text-secondary)] leading-[18px] text-[var(--color-ink-2)]">
          {person.roles.join(' · ')}
        </span>
      </span>
      <span className="mono shrink-0 text-mono text-[var(--color-ink-3)]">{plural(person.tracks, 'track')}</span>
    </button>
  )
})

function Credits({ onOpen }: { onOpen: (id: number) => void }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const revision = useLibraryChanges()
  const [dir, setDir] = useState<SortDir>('asc')
  const { rows, total, loading, waitVisible, ensureRange } = useLibraryPage<CreditRow>('library/credits', '', 'name', dir, revision)

  return (
    <>
      <SortLine
        count={loading ? 'people' : plural(total, 'person', 'people')}
        options={BY_NAME}
        value="name"
        dir={dir}
        kindOf={() => 'text'}
        onChange={(_, next) => {
          scrollRef.current?.scrollTo({ top: 0 })
          setDir(next)
        }}
      />
      <Scroller scrollRef={scrollRef} label="Credits">
        {loading ? (
          waitVisible && <RowsLoading height={PERSON_ROW} size={48} round label="Loading credits" />
        ) : total === 0 ? (
          <LibraryEmpty
            title="No credits yet"
            body="Producers and engineers appear here from your tags, and from MusicBrainz when enrichment is on."
          />
        ) : (
          <PagedRows
            scrollRef={scrollRef}
            label="Credits"
            rows={rows}
            total={total}
            ensureRange={ensureRange}
            rowHeight={PERSON_ROW}
            pending={<RowLoading size={48} round />}
            renderRow={(person) => <PersonRow person={person} onOpen={onOpen} />}
          />
        )}
      </Scroller>
    </>
  )
}
