import { useEffect, useState } from 'react'
import { AlertDialog } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { CoverArt } from '../ui/CoverArt'
import { IconButton } from '../ui/IconButton'
import { Mosaic } from '../ui/Mosaic'
import { TextField } from '../ui/TextField'
import { formatDuration, formatHoursMinutes, NO_VALUE, plural } from '../ui/format'
import { BackRow } from '../shell/SidePanel'
import { useGraph } from '../canvas/graphContext'
import { API_BASE as API } from '../config/serverHost'
import { useReconnectEpoch } from '../connect/reconnect'
import type { usePlayback } from '../playback/usePlayback'
import { totalDuration, usePlaylists, usePlaylistTracks, type PlaylistTrack } from './collectionsData'

/* One playlist: a hero with its mosaic, name and length; play and shuffle;
 * rename and delete; then its tracks. Clicking a track plays the playlist
 * from there. Hovering one swaps its duration for the controls that
 * reorder it, or take it out. */

type ImportReport = { sourceFilename: string; entries: { matchType: 'path' | 'metadata' | 'missing' }[] }

function useImportReport(playlistId: number): ImportReport | null {
  const [report, setReport] = useState<{ playlistId: number; report: ImportReport | null } | null>(null)
  // Again after an outage (#119).
  const reconnects = useReconnectEpoch()
  useEffect(() => {
    let cancelled = false
    fetch(`${API}/playlists/${playlistId}/import-report`)
      .then((r) => (r.ok ? r.json() : null))
      .then((value: ImportReport | null) => !cancelled && setReport({ playlistId, report: value }))
      .catch(() => !cancelled && setReport({ playlistId, report: null }))
    return () => {
      cancelled = true
    }
  }, [playlistId, reconnects])
  return report?.playlistId === playlistId ? report.report : null
}

type PlaylistPageProps = {
  playlistId: number
  onBack: () => void
  onFocusNode: (id: number) => void
  playback: ReturnType<typeof usePlayback>
}

export function PlaylistPage({ playlistId, onBack, onFocusNode, playback }: PlaylistPageProps) {
  const graph = useGraph()
  const { playlists } = usePlaylists()
  const { tracks, setTracks } = usePlaylistTracks(playlistId)
  const report = useImportReport(playlistId)
  const playlist = playlists?.find((p) => p.id === playlistId)
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState('')
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const rename = async () => {
    const next = name.trim()
    setRenaming(false)
    if (!next || next === playlist?.name) return
    await fetch(`${API}/playlists/${playlistId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: next }),
    })
  }

  const remove = async () => {
    await fetch(`${API}/playlists/${playlistId}`, { method: 'DELETE' })
    setConfirmingDelete(false)
    onBack()
  }

  // Reordering swaps neighbours: the server renumbers the whole playlist
  // from the one position it's sent, so an adjacent swap is all a move up
  // or down needs to say. Optimistic, so the row moves under the pointer.
  const move = async (index: number, direction: -1 | 1) => {
    if (!tracks) return
    const target = index + direction
    if (target < 0 || target >= tracks.length) return
    const moved = tracks[index]
    const neighbour = tracks[target]
    const next = tracks.slice()
    ;[next[index], next[target]] = [next[target], next[index]]
    setTracks(next)
    await fetch(`${API}/playlists/${playlistId}/tracks/${moved.playlist_track_id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: neighbour.position }),
    })
  }

  const removeTrack = async (track: PlaylistTrack) => {
    if (!tracks) return
    setTracks(tracks.filter((t) => t.playlist_track_id !== track.playlist_track_id))
    await fetch(`${API}/playlists/${playlistId}/tracks/${track.playlist_track_id}`, { method: 'DELETE' })
  }

  const missing = report?.entries.filter((e) => e.matchType === 'missing').length ?? 0
  const title = playlist?.name ?? ''

  return (
    <div className="flex flex-col">
      <BackRow label="Collections" onBack={onBack} />

      <div className="mt-[8px] flex items-end gap-[14px]">
        <Mosaic nodeIds={(tracks ?? []).slice(0, 4).map((t) => t.id)} size={120} radius={8} />
        <div className="flex min-w-0 flex-col gap-[2px]">
          <span className="text-small text-[var(--color-ink-2)]">playlist</span>
          {renaming ? (
            <TextField
              prose
              autoFocus
              label="Playlist name"
              value={name}
              onChange={setName}
              onEnter={() => void rename()}
              onEscape={() => setRenaming(false)}
            />
          ) : (
            <h2 className="text-[22px] leading-[28px] font-medium [overflow-wrap:anywhere] text-[var(--color-ink)]">{title}</h2>
          )}
          <span className="text-small text-[var(--color-ink-2)]">
            {tracks ? `${plural(tracks.length, 'track')} · ${formatHoursMinutes(totalDuration(tracks))}` : ' '}
          </span>
        </div>
      </div>

      {report && (
        <p className="mt-[12px] text-small text-[var(--color-ink-3)]">
          Imported from {report.sourceFilename}
          {missing > 0 ? ` · ${plural(missing, 'track')} missing` : ''}
        </p>
      )}

      <div className="mt-[14px] flex items-center gap-[8px]">
        <Button
          variant="primary"
          icon="play"
          disabled={!tracks?.length || playback.queueBusy}
          onClick={() => void playback.playPlaylist(playlistId)}
        >
          play
        </Button>
        <Button
          variant="secondary"
          icon="arrow-swap"
          disabled={!tracks?.length || playback.queueBusy}
          onClick={() => void playback.playPlaylist(playlistId, true)}
        >
          shuffle
        </Button>
        <span className="ml-auto flex">
          <IconButton
            icon="pencil"
            label="Rename playlist"
            active={renaming}
            onClick={() => {
              setName(title)
              setRenaming((v) => !v)
            }}
          />
          <IconButton icon="cancel" label="Delete playlist" onClick={() => setConfirmingDelete(true)} />
        </span>
      </div>

      {tracks && tracks.length === 0 && (
        <p className="mt-[24px] text-center text-[length:var(--text-secondary)] text-[var(--color-ink-2)]">
          Nothing in here yet. Add tracks with the + on any track.
        </p>
      )}
      <ol className="-mx-[8px] mt-[14px] flex flex-col">
        {(tracks ?? []).map((track, i) => (
          <li
            key={track.playlist_track_id}
            className="group grid h-[50px] grid-cols-[20px_36px_minmax(0,1fr)_auto] items-center gap-[10px] rounded-[var(--radius-control)] px-[8px] transition-colors duration-[var(--motion-fast)] hover:bg-[var(--color-wash)]"
          >
            <span className="mono text-right text-[length:var(--text-mono)] text-[var(--color-ink-3)]">{i + 1}</span>
            <CoverArt nodeId={track.id} size="thumb" radius="sm" className="size-[36px]" />
            <button
              type="button"
              onClick={() =>
                void playback.playTracks(
                  tracks!.map((t) => t.id),
                  i,
                  title,
                  { kind: 'playlist', playlistId },
                )
              }
              onDoubleClick={() => onFocusNode(track.id)}
              disabled={playback.queueBusy}
              className="flex min-w-0 flex-col text-left"
            >
              <span
                title={track.title}
                className="truncate text-[length:var(--text-body)] leading-[20px] font-medium text-[var(--color-ink)]"
              >
                {track.title}
              </span>
              <span className="truncate text-small text-[var(--color-ink-2)]">{graph.byId.get(track.id)?.subtitle ?? NO_VALUE}</span>
            </button>
            <span className="mono text-[length:var(--text-mono)] text-[var(--color-ink-2)] group-focus-within:hidden group-hover:hidden">
              {formatDuration(track.canonical_duration_ms)}
            </span>
            <span className="hidden items-center group-focus-within:flex group-hover:flex">
              <IconButton icon="chevron-up" label="Move up" size={26} disabled={i === 0} onClick={() => void move(i, -1)} />
              <IconButton
                icon="chevron-down"
                label="Move down"
                size={26}
                disabled={i === tracks!.length - 1}
                onClick={() => void move(i, 1)}
              />
              <IconButton icon="cancel" label="Remove from playlist" size={26} tone="ink-3" onClick={() => void removeTrack(track)} />
            </span>
          </li>
        ))}
      </ol>

      <AlertDialog
        open={confirmingDelete}
        onCancel={() => setConfirmingDelete(false)}
        onConfirm={() => void remove()}
        title={`Delete “${title}”?`}
        description="The playlist goes; the music stays in your library. This can't be undone."
        confirmLabel="Delete playlist"
      />
    </div>
  )
}
