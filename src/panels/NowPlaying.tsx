import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { Button } from '../ui/Button'
import { CoverArt } from '../ui/CoverArt'
import { Icon } from '../ui/Icon'
import { IconButton } from '../ui/IconButton'
import { Kbd } from '../ui/Kbd'
import { Skeleton } from '../ui/Skeleton'
import { Tabs } from '../ui/Tabs'
import { MOD_KEY_LABEL } from '../shell/keys'
import { formatDuration, NO_VALUE } from '../ui/format'
import { useGraph } from '../canvas/graphContext'
import type { NowPlayingTab } from '../shell/panels'
import type { QueueEntry, QueueSource, usePlayback } from '../playback/usePlayback'
import { AddToPlaylistButton } from './AddToPlaylistButton'
import { DetailRows } from './DetailRows'
import { formatBitrate, formatFormat } from './format'
import { currentLyricIndex, parseSyncedLyrics } from './lyrics'
import { useFavourite } from './useFavourite'
import { useLyrics } from './useLyrics'
import { API, useNodeDetail, type NodeDetail } from './useNodeDetail'

/* The right panel while it shows what's playing: the cover, the title, a few
 * actions, then up next / lyrics / details as underline tabs. It opens from
 * the player's queue button and closes the same way; node details replace
 * it, one right panel at a time.
 *
 * The full cover only heads the up-next tab. Lyrics and details are reading
 * views, so they take a compact header and give the space to the text. */

type Playback = ReturnType<typeof usePlayback>

const TABS = [
  { value: 'next', label: 'up next' },
  { value: 'lyrics', label: 'lyrics' },
  { value: 'details', label: 'details' },
] as const satisfies readonly { value: NowPlayingTab; label: string }[]

type NowPlayingProps = {
  nodeId: number | null
  tab: NowPlayingTab
  onTabChange: (tab: NowPlayingTab) => void
  playback: Playback
  onFocusNode: (id: number) => void
  onOpenDetails: (id: number) => void
  onShuffleLibrary: () => void
  onShowOnMap: (id: number) => void
}

function performer(node: NodeDetail) {
  return node.edges.find((e) => e.direction === 'out' && e.type === 'performed_by') ?? null
}

function release(node: NodeDetail) {
  return node.edges.find((e) => e.direction === 'out' && e.type === 'appears_on') ?? null
}

export function NowPlaying({
  nodeId,
  tab,
  onTabChange,
  playback,
  onFocusNode,
  onOpenDetails,
  onShuffleLibrary,
  onShowOnMap,
}: NowPlayingProps) {
  const { node } = useNodeDetail(nodeId)

  if (nodeId == null) {
    return (
      <Empty title="Nothing playing" body="Pick anything to play, or let the library choose.">
        <Button variant="secondary" icon="arrow-swap" onClick={onShuffleLibrary}>
          Shuffle library
        </Button>
      </Empty>
    )
  }
  // A real nodeId with no node yet: the detail fetch for a track that just
  // started hasn't landed.
  if (!node || node.id !== nodeId) return <NowPlayingSkeleton />

  const artist = performer(node)
  const album = release(node)

  return (
    <div className="flex flex-col">
      {tab === 'next' ? (
        <>
          <CoverArt
            nodeId={node.id}
            size="full"
            radius="hero"
            alt={`Cover art for ${node.title}`}
            className="aspect-square w-full shadow-[var(--shadow-panel)]"
          />
          <div className="mt-[16px] flex flex-col gap-[2px]">
            <h2 className="text-title text-[var(--color-ink)]">{node.title}</h2>
            <p className="truncate text-[length:var(--text-body)] leading-[20px]">
              {artist && (
                <button
                  type="button"
                  onClick={() => onFocusNode(artist.other_id)}
                  className="font-medium text-[var(--color-ink)] hover:underline"
                >
                  {artist.other_title}
                </button>
              )}
              {album && (
                <span className="text-[var(--color-ink-2)]">
                  {artist ? ' · ' : ''}
                  <button type="button" onClick={() => onFocusNode(album.other_id)} className="hover:text-[var(--color-ink)]">
                    {album.other_title}
                  </button>
                </span>
              )}
            </p>
          </div>
        </>
      ) : (
        <CompactHeader node={node} artist={artist?.other_title ?? null} album={album?.other_title ?? null} />
      )}

      <div className="mt-[12px] flex items-center gap-[2px]">
        <FavouriteButton node={node} />
        <AddToPlaylistButton nodeId={node.id} />
        <IconButton icon="info" label="Details" onClick={() => onOpenDetails(node.id)} />
        <Button className="ml-auto" onClick={() => onShowOnMap(node.id)}>
          show on map
        </Button>
      </div>

      <Tabs
        label="now playing"
        variant="underline"
        options={TABS}
        value={tab}
        onChange={onTabChange}
        className="mt-[16px] w-full border-b border-[var(--color-line)]"
      />

      {tab === 'next' && <UpNext playback={playback} albumTitle={album?.other_title ?? null} onShuffleLibrary={onShuffleLibrary} />}
      {tab === 'lyrics' && <Lyrics nodeId={node.id} positionMs={playback.status.positionMs} />}
      {tab === 'details' && <TrackDetails node={node} artist={artist?.other_title ?? null} album={album?.other_title ?? null} />}
    </div>
  )
}

function FavouriteButton({ node }: { node: NodeDetail }) {
  const [isFavourite, toggle] = useFavourite(node.id, node.is_favourite)
  return (
    <IconButton
      icon="heart"
      label={isFavourite ? 'Remove from favourites' : 'Add to favourites'}
      filled={isFavourite}
      active={isFavourite}
      aria-pressed={isFavourite}
      onClick={toggle}
    />
  )
}

function CompactHeader({ node, artist, album }: { node: NodeDetail; artist: string | null; album: string | null }) {
  return (
    <div className="flex items-end gap-[12px]">
      <CoverArt nodeId={node.id} size="thumb" radius="hero" alt="" className="size-[96px] shadow-[var(--shadow-sm)]" />
      <div className="flex min-w-0 flex-col gap-[2px]">
        <h2 className="text-[17px] leading-[22px] font-medium text-[var(--color-ink)]">{node.title}</h2>
        {artist && (
          <span className="truncate text-[length:var(--text-body)] leading-[20px] font-medium text-[var(--color-ink)]">{artist}</span>
        )}
        {album && <span className="truncate text-small text-[var(--color-ink-2)]">{album}</span>}
      </div>
    </div>
  )
}

export function Empty({ title, body, icon, children }: { title: string; body: ReactNode; icon?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-[10px] px-[12px] pt-[48px] text-center">
      {icon && <span className="text-[var(--color-ink-3)]">{icon}</span>}
      <span className="text-heading text-[var(--color-ink)]">{title}</span>
      <span className="text-[length:var(--text-secondary)] leading-[18px] text-[var(--color-ink-2)]">{body}</span>
      {children && <div className="mt-[4px] flex gap-[8px]">{children}</div>}
    </div>
  )
}

/* ---- Up next ------------------------------------------------------------- */

function sourceLabel(source: QueueSource | null, albumTitle: string | null, playlistNames: Map<number, string>): string | null {
  if (source == null) return null
  if (source.kind === 'library') return 'your library, shuffled'
  if (source.kind === 'playlist') return playlistNames.get(source.playlistId) ?? 'a playlist'
  return albumTitle
}

function usePlaylistName(source: QueueSource | null): Map<number, string> {
  const [names, setNames] = useState(new Map<number, string>())
  const playlistId = source?.kind === 'playlist' ? source.playlistId : null
  useEffect(() => {
    if (playlistId == null || names.has(playlistId)) return
    let cancelled = false
    fetch(`${API}/playlists`)
      .then((r) => r.json())
      .then((list: { id: number; name: string }[]) => {
        if (!cancelled) setNames(new Map(list.map((p) => [p.id, p.name])))
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [playlistId, names])
  return names
}

function UpNext({
  playback,
  albumTitle,
  onShuffleLibrary,
}: {
  playback: Playback
  albumTitle: string | null
  onShuffleLibrary: () => void
}) {
  const graph = useGraph()
  const playlistNames = usePlaylistName(playback.queueSource)
  const from = sourceLabel(playback.queueSource, albumTitle, playlistNames)
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)

  if (playback.upNext.length === 0) {
    return (
      <Empty
        title="Nothing after this track"
        body={
          <>
            Add tracks from anywhere with <Kbd>{MOD_KEY_LABEL}↵</Kbd>, or keep going.
          </>
        }
      >
        <Button variant="secondary" icon="arrow-swap" onClick={onShuffleLibrary}>
          Shuffle library
        </Button>
      </Empty>
    )
  }

  // There's no "jump to index" in the player, so a row click steps forward
  // that many times — each step is serialized behind the last.
  const jumpTo = async (index: number) => {
    for (let i = 0; i <= index; i++) await playback.next()
  }

  const onDrop = (e: DragEvent, index: number) => {
    e.preventDefault()
    if (dragFrom != null && dragFrom !== index) void playback.moveUpNext(dragFrom, index)
    setDragFrom(null)
    setDropAt(null)
  }

  return (
    <>
      <div className="mt-[12px] flex items-center justify-between gap-[8px] text-small text-[var(--color-ink-2)]">
        <span className="min-w-0 truncate">
          {from ? (
            <>
              Playing from <span className="text-[var(--color-ink)]">{from}</span>
            </>
          ) : (
            `${playback.upNext.length} up next`
          )}
        </span>
        <Button onClick={() => void playback.clearUpNext()} disabled={playback.queueBusy}>
          clear
        </Button>
      </div>
      <ol className="-mx-[6px] mt-[6px] flex flex-col">
        {playback.upNext.map((entry, i) => (
          <UpNextRow
            key={`${entry.recordingNodeId}-${i}`}
            entry={entry}
            index={i}
            count={playback.upNext.length}
            artist={graph.byId.get(entry.recordingNodeId)?.subtitle ?? null}
            busy={playback.queueBusy}
            dropTarget={dropAt === i && dragFrom !== i}
            onPlay={() => void jumpTo(i)}
            onMove={(to) => void playback.moveUpNext(i, to)}
            onRemove={() => void playback.removeUpNext(i)}
            onDragStart={() => setDragFrom(i)}
            onDragOver={(e) => {
              e.preventDefault()
              setDropAt(i)
            }}
            onDrop={(e) => onDrop(e, i)}
            onDragEnd={() => {
              setDragFrom(null)
              setDropAt(null)
            }}
          />
        ))}
      </ol>
    </>
  )
}

type UpNextRowProps = {
  entry: QueueEntry
  index: number
  count: number
  artist: string | null
  busy: boolean
  dropTarget: boolean
  onPlay: () => void
  onMove: (to: number) => void
  onRemove: () => void
  onDragStart: () => void
  onDragOver: (e: DragEvent) => void
  onDrop: (e: DragEvent) => void
  onDragEnd: () => void
}

/* 50px rows: cover, title over artist, and the duration — which hover swaps
 * for a drag handle. The handle is also the keyboard way to reorder: arrow
 * keys move the track, Delete takes it out of the queue. */
function UpNextRow({
  entry,
  index,
  count,
  artist,
  busy,
  dropTarget,
  onPlay,
  onMove,
  onRemove,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: UpNextRowProps) {
  return (
    <li
      draggable={!busy}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        onDragStart()
      }}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      className={`group relative grid h-[50px] grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-[10px] rounded-[var(--radius-control)] px-[6px] transition-colors duration-[var(--motion-fast)] hover:bg-[var(--color-wash)] ${
        dropTarget ? 'shadow-[inset_0_2px_0_var(--color-accent)]' : ''
      }`}
    >
      <CoverArt nodeId={entry.recordingNodeId} size="thumb" radius="sm" className="size-[36px]" />
      <button type="button" onClick={onPlay} disabled={busy} className="flex min-w-0 flex-col text-left disabled:pointer-events-none">
        <span title={entry.title} className="truncate text-[length:var(--text-body)] leading-[20px] font-medium text-[var(--color-ink)]">
          {entry.title}
        </span>
        <span className="truncate text-small text-[var(--color-ink-2)]">{artist ?? NO_VALUE}</span>
      </button>
      <span className="mono text-[length:var(--text-mono)] text-[var(--color-ink-2)] group-focus-within:hidden group-hover:hidden">
        {formatDuration(entry.durationMs)}
      </span>
      <button
        type="button"
        aria-label={`Reorder ${entry.title}`}
        aria-description="Arrow keys move it, Delete removes it from the queue"
        disabled={busy}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp' && index > 0) {
            e.preventDefault()
            onMove(index - 1)
          } else if (e.key === 'ArrowDown' && index < count - 1) {
            e.preventDefault()
            onMove(index + 1)
          } else if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault()
            onRemove()
          }
        }}
        className="hidden cursor-grab text-[var(--color-ink-2)] group-focus-within:inline-flex group-hover:inline-flex active:cursor-grabbing"
      >
        <Icon name="list" size={18} />
      </button>
    </li>
  )
}

/* ---- Lyrics -------------------------------------------------------------- */

function Lyrics({ nodeId, positionMs }: { nodeId: number; positionMs: number }) {
  const { lyrics, lyricsWaitVisible } = useLyrics(nodeId, true)
  const synced = useMemo(
    () => (lyrics && lyrics !== 'loading' && lyrics.syncedLyrics ? parseSyncedLyrics(lyrics.syncedLyrics) : null),
    [lyrics],
  )
  const current = synced ? currentLyricIndex(synced, positionMs) : -1
  const currentRef = useRef<HTMLSpanElement>(null)

  // Keep the sung line in view as the song moves, without yanking the
  // panel if the reader has scrolled away to read ahead — "nearest" only
  // moves it when it has left the visible area.
  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [current])

  if (lyrics === 'loading') {
    return lyricsWaitVisible ? (
      <p className="mt-[16px] text-[length:var(--text-secondary)] text-[var(--color-ink-3)]">Looking up lyrics…</p>
    ) : null
  }
  if (lyrics === null || !lyrics.found) {
    return (
      <Empty
        icon={<Icon name="info" size={24} />}
        title="No lyrics found"
        body="Nothing matched this track. Instrumentals show as instrumental instead."
      />
    )
  }
  if (lyrics.instrumental) return <Empty title="Instrumental" body="This track has no words to show." />

  const lineClass = 'text-[17px] leading-[26px] [text-wrap:pretty]'
  if (synced && synced.length > 0) {
    return (
      <div className="mt-[16px] flex flex-col gap-[6px]">
        {synced.map((line, i) =>
          line.text === '' ? (
            <span key={i} aria-hidden="true" className="h-[10px]" />
          ) : (
            <span
              key={i}
              ref={i === current ? currentRef : undefined}
              aria-current={i === current ? 'true' : undefined}
              className={`${lineClass} transition-colors duration-[var(--motion-base)] ${
                i === current
                  ? 'font-medium text-[var(--color-ink)]'
                  : i < current
                    ? 'text-[var(--color-ink-3)]'
                    : 'text-[var(--color-ink-2)]'
              }`}
            >
              {line.text}
            </span>
          ),
        )}
      </div>
    )
  }
  // Unsynced lyrics have no "now", so every line is simply text to read.
  return (
    <div data-selectable className="mt-[16px] flex flex-col gap-[6px]">
      {(lyrics.plainLyrics ?? '').split(/\n/).map((line, i) =>
        line.trim() === '' ? (
          <span key={i} aria-hidden="true" className="h-[10px]" />
        ) : (
          <span key={i} className={`${lineClass} text-[var(--color-ink)]`}>
            {line}
          </span>
        ),
      )}
    </div>
  )
}

/* ---- Details ------------------------------------------------------------- */

function TrackDetails({ node, artist, album }: { node: NodeDetail; artist: string | null; album: string | null }) {
  const file = node.files[0]
  const rows = [
    { label: 'artist', value: artist ?? NO_VALUE },
    { label: 'album', value: album ?? NO_VALUE },
    { label: 'track', value: file?.track_no ?? NO_VALUE },
    { label: 'length', value: formatDuration(node.recording?.canonical_duration_ms) },
    { label: 'format', value: [formatFormat(file?.format), formatBitrate(file?.bitrate)].filter(Boolean).join(' · ') || NO_VALUE },
    { label: 'release date', value: file?.release_date ?? NO_VALUE },
    { label: 'plays', value: node.playCount ?? 0 },
  ]
  return (
    <div className="mt-[12px] flex flex-col gap-[14px]">
      <DetailRows rows={rows} />
      {file && (
        <p data-selectable title={file.file_path} className="mono text-[11px] leading-[16px] break-all text-[var(--color-ink-3)]">
          {file.file_path}
        </p>
      )}
    </div>
  )
}

/* ---- Loading ------------------------------------------------------------- */

function NowPlayingSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading" className="flex flex-col gap-[12px]">
      <Skeleton className="aspect-square w-full rounded-[10px]" />
      <Skeleton className="h-[16px] w-[70%] rounded-[6px]" />
      <Skeleton tone="faint" className="h-[12px] w-[45%] rounded-[6px]" />
      <div className="mt-[12px] flex gap-[8px]">
        <Skeleton className="h-[32px] w-[84px] rounded-full" />
        <Skeleton tone="faint" className="h-[32px] w-[96px] rounded-full" />
      </div>
      {[80, 62, 74, 55, 68].map((width, i) => (
        <div key={i} className="flex h-[40px] items-center gap-[10px]">
          <Skeleton tone="faint" className="h-[10px] w-[20px] rounded-[4px]" />
          <Skeleton tone="faint" className="h-[12px] rounded-[6px]" style={{ width: `${width}%` }} />
        </div>
      ))}
    </div>
  )
}
