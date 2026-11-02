import { useEffect, useState, type ReactNode } from 'react'
import { IconButton } from '../ui/IconButton'
import { Popover } from '../ui/Popover'
import { ScrollingText } from '../ui/ScrollingText'
import { TextField } from '../ui/TextField'
import { plural } from '../ui/format'
import { API_BASE as API } from '../config/serverHost'
import { useReconnectEpoch } from '../connect/reconnect'

type PlaylistListItem = { id: number; name: string; track_count: number }

/** What goes into a playlist: one track, or every track on an album (#448). */
export type PlaylistAddition = { nodeId: number; albumId?: undefined } | { albumId: number; nodeId?: undefined }

/* The tracks an addition stands for, in order. An album's are its
 * tracklist, the disc and track order playing it uses. */
async function trackIds(what: PlaylistAddition): Promise<number[]> {
  if (what.albumId == null) return [what.nodeId]
  const response = await fetch(`${API}/nodes/${what.albumId}/tracklist`)
  if (!response.ok) throw new Error(`tracklist ${response.status}`)
  return ((await response.json()) as { id: number }[]).map((t) => t.id)
}

/* How long the picker stays open once the add lands: long enough to read
 * "added", and longer for a count. */
const CLOSE_AFTER_MS = 500
const CLOSE_AFTER_COUNT_MS = 1200

type AddToPlaylistButtonProps = PlaylistAddition & {
  size?: number
  /** The button's name and tooltip. */
  label?: string
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

/* The + that opens the playlist picker: a track's or an album's header,
 * the map's card, now playing, and every desktop track row (#447). The
 * picker is a Popover, portaled, so a row deep in a scroller or the
 * virtualised tracks table opens it without being cropped. Clicks and keys
 * inside it stay inside it: a row that opens its details on a click, or the
 * search palette that reads every key, never sees them. */
export function AddToPlaylistButton({ size = 32, label, open, onOpenChange, ...what }: AddToPlaylistButtonProps) {
  const addition = what as PlaylistAddition
  return (
    <span className="inline-flex" onClick={(e) => e.stopPropagation()}>
      <Popover
        label="Add to playlist"
        placement="bottom"
        align="end"
        className="w-[240px] p-[8px]"
        open={open}
        onOpenChange={onOpenChange}
        trigger={({ open: isOpen, ...props }) => (
          <IconButton
            icon="add"
            label={label ?? (addition.albumId != null ? 'Add album to playlist' : 'Add to playlist')}
            size={size}
            active={isOpen}
            {...props}
          />
        )}
      >
        {(close) => (
          <div onKeyDown={(e) => e.stopPropagation()}>
            <PlaylistPicker {...addition} onDone={close} />
          </div>
        )}
      </Popover>
    </span>
  )
}

/** A track row's end on the desktop: its duration, which hover or focus
 * anywhere in the row (the `group`) swaps for add to playlist, the way up
 * next's rows swap theirs for their controls (#447). Both sit in one grid
 * cell, so the column is as wide as the wider of the two and nothing in
 * the row moves when they swap. While the picker is open the button stays,
 * since the picker is what has the focus then. */
export function RowAddToPlaylist({ nodeId, children, size = 26 }: { nodeId: number; children: ReactNode; size?: number }) {
  const [open, setOpen] = useState(false)
  return (
    <span className="grid items-center justify-items-end">
      <span className={`[grid-area:1/1] ${open ? 'invisible' : 'group-focus-within:invisible group-hover:invisible'}`}>{children}</span>
      <span className={`[grid-area:1/1] inline-flex ${open ? '' : 'invisible group-focus-within:visible group-hover:visible'}`}>
        <AddToPlaylistButton nodeId={nodeId} size={size} open={open} onOpenChange={setOpen} />
      </span>
    </span>
  )
}

type Result = { playlistId: number; name: string } & ({ state: 'adding' } | { state: 'added'; count: number } | { state: 'failed' })

function resultWords(result: Result, several: boolean): { row: string; status: string } {
  if (result.state === 'adding') return { row: '', status: '' }
  if (result.state === 'failed') return { row: 'not added', status: `Couldn't add to ${result.name}` }
  return several
    ? { row: `added ${plural(result.count, 'track')}`, status: `Added ${plural(result.count, 'track')} to ${result.name}` }
    : { row: 'added', status: `Added to ${result.name}` }
}

/** The playlists to add a track or an album to, and a field to make a new
 * one: the button's popover, and the phone's menus (#389), where `sheet`
 * makes each row and the field 44px. It loads as it mounts, so each open
 * lists what's there now.
 *
 * An album's tracks go in at once, in its order, and the row it went to
 * says how many ("added 9 tracks"). A track that's already in the playlist
 * goes in again, as it always has (DESIGN.md, "Adding to a playlist"). */
export function PlaylistPicker({ onDone, sheet = false, ...what }: PlaylistAddition & { onDone: () => void; sheet?: boolean }) {
  const addition = what as PlaylistAddition
  const several = addition.albumId != null
  const [playlists, setPlaylists] = useState<PlaylistListItem[] | null>(null)
  const [newName, setNewName] = useState('')
  const [result, setResult] = useState<Result | null>(null)
  // An open list loads again after an outage (#119).
  const reconnects = useReconnectEpoch()

  useEffect(() => {
    // Clears the last load's list before refetching, so a stale list can't be clicked.
    // oxlint-disable-next-line react/set-state-in-effect
    setPlaylists(null)
    setResult(null)
    fetch(`${API}/playlists`)
      .then((r) => r.json())
      .then(setPlaylists)
      .catch(() => setPlaylists([]))
  }, [reconnects])

  const addTo = async (playlist: { id: number; name: string }) => {
    if (result?.state === 'adding') return
    setResult({ playlistId: playlist.id, name: playlist.name, state: 'adding' })
    try {
      const ids = await trackIds(addition)
      if (ids.length === 0) throw new Error('nothing to add')
      // One track goes as { nodeId }, which every server version takes.
      const response = await fetch(`${API}/playlists/${playlist.id}/tracks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(several ? { nodeIds: ids } : { nodeId: ids[0] }),
      })
      if (!response.ok) throw new Error(`add ${response.status}`)
      setResult({ playlistId: playlist.id, name: playlist.name, state: 'added', count: ids.length })
      setTimeout(onDone, several ? CLOSE_AFTER_COUNT_MS : CLOSE_AFTER_MS)
    } catch {
      setResult({ playlistId: playlist.id, name: playlist.name, state: 'failed' })
    }
  }

  const createAndAdd = async () => {
    const name = newName.trim()
    if (!name || result?.state === 'adding') return
    const playlist = (await fetch(`${API}/playlists`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)) as PlaylistListItem | null
    if (!playlist) return
    setNewName('')
    setPlaylists((all) => (all && !all.some((p) => p.id === playlist.id) ? [playlist, ...all] : all))
    await addTo(playlist)
  }

  const words = result ? resultWords(result, several) : null

  return (
    <>
      {playlists === null ? (
        <p className="text-[length:var(--text-secondary)] text-[var(--color-ink-3)]">loading…</p>
      ) : playlists.length === 0 ? (
        <p className="text-[length:var(--text-secondary)] text-[var(--color-ink-3)]">No playlists yet</p>
      ) : (
        <ul className={`flex flex-col overflow-y-auto ${sheet ? 'max-h-[264px]' : 'max-h-[180px]'}`}>
          {playlists.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => void addTo(p)}
                className={`flex w-full items-center gap-[4px] rounded-[8px] px-[8px] text-left text-[var(--color-ink)] transition-colors duration-150 hover:bg-[var(--color-wash)] ${
                  sheet ? 'h-[44px]' : 'h-[32px]'
                }`}
              >
                <ScrollingText
                  text={p.name}
                  className={`min-w-0 flex-1 ${sheet ? 'text-[length:var(--text-body)]' : 'text-[length:var(--text-secondary)]'}`}
                />
                {result?.playlistId === p.id && words?.row && (
                  <span
                    className={`shrink-0 text-small ${result.state === 'failed' ? 'text-[var(--color-bad)]' : 'text-[var(--color-ok)]'}`}
                  >
                    {words.row}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      {/* For a screen reader, the whole of it: what went where. */}
      <p role="status" className="sr-only">
        {words?.status ?? ''}
      </p>
      {/* Not until the list is here: the popover gives the focus to the
       * first thing in it that takes one, and that should be a playlist,
       * or the popup itself, never a field nobody asked to type in. */}
      {playlists !== null && (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void createAndAdd()
          }}
          className="mt-[8px] flex items-center gap-[6px] border-t border-[var(--color-line)] pt-[8px]"
        >
          <TextField
            prose
            size={sheet ? 'lg' : 'md'}
            value={newName}
            onChange={setNewName}
            placeholder="New playlist…"
            label="New playlist name"
            className="flex-1"
          />
          <IconButton
            icon="add"
            label="Create playlist and add"
            onClick={() => void createAndAdd()}
            {...(sheet ? { size: 44, iconSize: 20, tooltip: false } : {})}
          />
        </form>
      )}
    </>
  )
}
