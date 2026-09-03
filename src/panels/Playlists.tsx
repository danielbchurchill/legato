import { useCallback, useEffect, useState } from 'react'
import { useWsEvent } from '../hooks/useWs'
import { Icon } from '../ui/Icon'
import { CoverArt } from '../ui/CoverArt'
import { ScrollingText } from '../ui/ScrollingText'
import { Tooltip } from '../ui/Tooltip'
import { Button } from '../ui/Button'
import { formatDuration } from '../ui/format'
import { SERVER_HOST } from '../config/serverHost'
import type { usePlayback } from '../playback/usePlayback'

const API = `http://${SERVER_HOST}:8899/api/v1`

/* The Playlists rail destination: a flat list of named playlists (mirrors
 * Favourites.tsx's own top-level shape) that opens into a per-playlist
 * detail view — ordered tracks, reorderable by up/down buttons rather than
 * drag-and-drop (no such library is in package.json, and this repo doesn't
 * reach for a new dependency for one control). Both views live in this one
 * file, same as CollectionPanel.tsx's several small components, rather than
 * splitting list/detail across files for something this size.
 *
 * List <-> detail is local component state, not a route — nothing else in
 * the app needs to deep-link into a specific playlist yet. */

type PlaylistListItem = { id: number; name: string; track_count: number }
type PlaylistTrackDetail = {
  id: number
  title: string
  canonical_duration_ms: number | null
  position: number
  playlist_track_id: number
}

type Playback = Pick<ReturnType<typeof usePlayback>, 'playTracks' | 'playPlaylist'>

function CreatePlaylistForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed || submitting) return
    setSubmitting(true)
    await fetch(`${API}/playlists`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: trimmed }),
    })
    setName('')
    setSubmitting(false)
    onCreated()
  }

  return (
    <form onSubmit={submit} className="mb-[15px] flex items-center gap-[10px]">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="new playlist…"
        aria-label="New playlist name"
        className="min-w-0 flex-1 rounded-[var(--radius-control)] border border-[var(--color-hairline)] bg-[var(--color-inset)] px-[12px] py-[8px] text-[length:var(--text-base)] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-muted)]"
      />
      <Button type="submit" disabled={!name.trim() || submitting}>
        + create
      </Button>
    </form>
  )
}

function PlaylistRow({
  playlist,
  onOpen,
  onRename,
  onDelete,
}: {
  playlist: PlaylistListItem
  onOpen: (id: number, name: string) => void
  onRename: (id: number, name: string) => void
  onDelete: (id: number) => void
}) {
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(playlist.name)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  useEffect(() => setName(playlist.name), [playlist.name])

  if (confirmingDelete) {
    return (
      <div className="border-b border-[var(--color-divider)] py-[10px] last:border-b-0">
        <p className="text-[length:var(--text-base)] text-[var(--color-muted)]">
          Delete "{playlist.name}"? This can't be undone.
        </p>
        <div className="mt-[8px] flex items-center gap-[16px]">
          <Button variant="destructive" onClick={() => onDelete(playlist.id)}>
            delete
          </Button>
          <button
            type="button"
            onClick={() => setConfirmingDelete(false)}
            className="text-[length:var(--text-base)] text-[var(--color-muted)] transition-colors duration-150 hover:text-[var(--color-muted-hi)]"
          >
            cancel
          </button>
        </div>
      </div>
    )
  }

  if (renaming) {
    const commit = () => {
      const trimmed = name.trim()
      if (trimmed && trimmed !== playlist.name) onRename(playlist.id, trimmed)
      setRenaming(false)
    }
    return (
      <div className="border-b border-[var(--color-divider)] py-[10px] last:border-b-0">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commit()
            } else if (e.key === 'Escape') {
              setName(playlist.name)
              setRenaming(false)
            }
          }}
          aria-label="Playlist name"
          className="w-full bg-transparent font-[family-name:var(--font-mono)] text-[length:var(--text-base)] text-[var(--color-ink)] outline-none"
        />
      </div>
    )
  }

  return (
    <div className="flex items-center gap-[12px] border-b border-[var(--color-divider)] py-[10px] last:border-b-0">
      <button type="button" onClick={() => onOpen(playlist.id, playlist.name)} className="block min-w-0 flex-1 text-left text-[var(--color-ink)]">
        <ScrollingText text={playlist.name} className="font-[family-name:var(--font-mono)] text-[length:var(--text-base)]" />
        <span className="text-[length:var(--text-base)] text-[var(--color-muted)]">
          {playlist.track_count} track{playlist.track_count === 1 ? '' : 's'}
        </span>
      </button>
      <Tooltip label="Rename playlist">
        <button
          type="button"
          onClick={() => setRenaming(true)}
          aria-label="Rename playlist"
          className="shrink-0 text-[var(--color-muted)] transition-colors duration-150 hover:text-[var(--color-muted-hi)]"
        >
          <Icon name="pencil" size={24} />
        </button>
      </Tooltip>
      <Tooltip label="Delete playlist">
        <button
          type="button"
          onClick={() => setConfirmingDelete(true)}
          aria-label="Delete playlist"
          className="shrink-0 text-[var(--color-muted)] transition-colors duration-150 hover:text-[var(--color-muted-hi)]"
        >
          <Icon name="cancel" size={24} />
        </button>
      </Tooltip>
    </div>
  )
}

function PlaylistList({ onOpen }: { onOpen: (id: number, name: string) => void }) {
  const [items, setItems] = useState<PlaylistListItem[] | null>(null)

  const load = useCallback(() => {
    fetch(`${API}/playlists`)
      .then((r) => r.json())
      .then(setItems)
      .catch(() => setItems([]))
  }, [])

  useEffect(load, [load])
  useWsEvent(['playlist:changed'], load)

  const rename = async (id: number, name: string) => {
    setItems((prev) => (prev ?? []).map((p) => (p.id === id ? { ...p, name } : p)))
    await fetch(`${API}/playlists/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
  }

  const remove = async (id: number) => {
    setItems((prev) => (prev ?? []).filter((p) => p.id !== id))
    await fetch(`${API}/playlists/${id}`, { method: 'DELETE' })
  }

  return (
    <div>
      <CreatePlaylistForm onCreated={load} />
      {items === null ? (
        <p className="text-[length:var(--text-base)] text-[var(--color-muted)]">loading…</p>
      ) : items.length === 0 ? (
        <p className="text-[length:var(--text-base)] text-[var(--color-muted)]">
          No playlists yet — create one above to start collecting tracks.
        </p>
      ) : (
        <div>
          {items.map((p) => (
            <PlaylistRow key={p.id} playlist={p} onOpen={onOpen} onRename={rename} onDelete={remove} />
          ))}
        </div>
      )}
    </div>
  )
}

function PlaylistTrackRow({
  track,
  isFirst,
  isLast,
  onPlay,
  onRemove,
  onMoveUp,
  onMoveDown,
}: {
  track: PlaylistTrackDetail
  isFirst: boolean
  isLast: boolean
  onPlay: () => void
  onRemove: () => void
  onMoveUp: () => void
  onMoveDown: () => void
}) {
  return (
    <div className="flex items-center gap-[12px] border-b border-[var(--color-divider)] py-[10px] last:border-b-0">
      <div className="h-[75px] w-[75px] shrink-0">
        <CoverArt nodeId={track.id} size="thumb" alt={track.title} className="aspect-square w-full" />
      </div>
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={onPlay}
          className="block w-full text-left text-[var(--color-ink)] transition-colors duration-150 hover:text-[var(--color-muted-hi)]"
        >
          <ScrollingText text={track.title} className="font-[family-name:var(--font-mono)] text-[length:var(--text-base)]" />
        </button>
        <span className="font-[family-name:var(--font-mono)] text-[length:var(--text-base)] text-[var(--color-muted)]">
          {formatDuration(track.canonical_duration_ms)}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-[4px]">
        <Tooltip label="Move up">
          <button
            type="button"
            onClick={onMoveUp}
            disabled={isFirst}
            aria-label="Move up"
            className="text-[var(--color-muted)] transition-colors duration-150 hover:text-[var(--color-muted-hi)] disabled:pointer-events-none disabled:opacity-30"
          >
            <Icon name="chevron-up" size={20} />
          </button>
        </Tooltip>
        <Tooltip label="Move down">
          <button
            type="button"
            onClick={onMoveDown}
            disabled={isLast}
            aria-label="Move down"
            className="text-[var(--color-muted)] transition-colors duration-150 hover:text-[var(--color-muted-hi)] disabled:pointer-events-none disabled:opacity-30"
          >
            <Icon name="chevron-down" size={20} />
          </button>
        </Tooltip>
        <Tooltip label="Remove from playlist">
          <button
            type="button"
            onClick={onRemove}
            aria-label="Remove from playlist"
            className="text-[var(--color-muted)] transition-colors duration-150 hover:text-[var(--color-muted-hi)]"
          >
            <Icon name="cancel" size={20} />
          </button>
        </Tooltip>
      </div>
    </div>
  )
}

function PlaylistDetail({
  playlistId,
  playlistName,
  onBack,
  playback,
}: {
  playlistId: number
  playlistName: string
  onBack: () => void
  playback: Playback
}) {
  const [tracks, setTracks] = useState<PlaylistTrackDetail[] | null>(null)

  const load = useCallback(() => {
    fetch(`${API}/playlists/${playlistId}/tracks`)
      .then((r) => r.json())
      .then(setTracks)
      .catch(() => setTracks([]))
  }, [playlistId])

  useEffect(load, [load])
  useWsEvent(['playlist:tracks-changed'], (payload) => {
    if ((payload as { playlistId?: number } | undefined)?.playlistId === playlistId) load()
  })

  const remove = async (trackRowId: number) => {
    setTracks((prev) => (prev ?? []).filter((t) => t.playlist_track_id !== trackRowId))
    await fetch(`${API}/playlists/${playlistId}/tracks/${trackRowId}`, { method: 'DELETE' })
  }

  // Swaps two adjacent rows by sending the neighbor's current `position`
  // for the moved row's playlist_track_id — reorderPlaylistTrack
  // (server/src/routes/playlists.ts) renumbers the whole playlist from that
  // single value, so an adjacent-neighbor swap is all a "move up/down"
  // button ever needs to express.
  const move = async (index: number, direction: -1 | 1) => {
    if (!tracks) return
    const targetIndex = index + direction
    if (targetIndex < 0 || targetIndex >= tracks.length) return
    const moved = tracks[index]
    const neighbor = tracks[targetIndex]

    setTracks((prev) => {
      if (!prev) return prev
      const next = prev.slice()
      ;[next[index], next[targetIndex]] = [next[targetIndex], next[index]]
      return next
    })

    await fetch(`${API}/playlists/${playlistId}/tracks/${moved.playlist_track_id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: neighbor.position }),
    })
  }

  const playFrom = (index: number) => {
    if (!tracks) return
    playback.playTracks(
      tracks.map((t) => t.id),
      index,
      playlistName,
    )
  }

  return (
    <div>
      <button
        type="button"
        onClick={onBack}
        className="mb-[15px] text-[length:var(--text-base)] text-[var(--color-muted)] transition-colors duration-150 hover:text-[var(--color-muted-hi)]"
      >
        ← playlists
      </button>

      <ScrollingText
        text={playlistName}
        className="font-[family-name:var(--font-mono)] text-[length:var(--text-base)] text-[var(--color-ink)]"
      />

      <div className="mt-[8px] flex items-center gap-[16px]">
        <Button onClick={() => void playback.playPlaylist(playlistId)}>play</Button>
        <Button onClick={() => void playback.playPlaylist(playlistId, true)}>shuffle play</Button>
      </div>

      {tracks === null ? (
        <p className="pt-[24px] text-[length:var(--text-base)] text-[var(--color-muted)]">loading…</p>
      ) : tracks.length === 0 ? (
        <p className="pt-[24px] text-center text-[length:var(--text-base)] text-[var(--color-muted)]">
          No tracks yet — use "add to playlist" on any track to add one.
        </p>
      ) : (
        <div className="mt-[15px]">
          {tracks.map((t, i) => (
            <PlaylistTrackRow
              key={t.playlist_track_id}
              track={t}
              isFirst={i === 0}
              isLast={i === tracks.length - 1}
              onPlay={() => playFrom(i)}
              onRemove={() => void remove(t.playlist_track_id)}
              onMoveUp={() => void move(i, -1)}
              onMoveDown={() => void move(i, 1)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export function Playlists({ playback }: { playback: Playback }) {
  const [selected, setSelected] = useState<{ id: number; name: string } | null>(null)

  if (selected) {
    return (
      <PlaylistDetail
        playlistId={selected.id}
        playlistName={selected.name}
        onBack={() => setSelected(null)}
        playback={playback}
      />
    )
  }

  return <PlaylistList onOpen={(id, name) => setSelected({ id, name })} />
}
