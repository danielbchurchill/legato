import { useEffect, useRef, useState } from 'react'
import { IconButton } from '../ui/IconButton'
import { ScrollingText } from '../ui/ScrollingText'
import { TextField } from '../ui/TextField'
import { API_BASE as API } from '../config/serverHost'
import { useReconnectEpoch } from '../connect/reconnect'

type PlaylistListItem = { id: number; name: string; track_count: number }

/* The one write path from a track row into a playlist besides the playlist
 * detail view's own reordering (Playlists.tsx). A click-to-open popover on
 * the same glass recipe as Popover.tsx (C-1), not a Popover itself — that
 * component's job is a static info blurb, this one fetches, lists, and
 * submits. Fetches fresh every time it opens rather than subscribing to
 * playlist:changed — it's a few-hundred-ms-lived popover, not a standing
 * surface, so there's nothing to keep in sync between opens. */
export function AddToPlaylistButton({ nodeId, size = 32 }: { nodeId: number; size?: number }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  return (
    <div ref={rootRef} className="relative inline-flex">
      <IconButton icon="add" label="Add to playlist" size={size} active={open} aria-expanded={open} onClick={() => setOpen((v) => !v)} />
      {open && (
        <div
          role="dialog"
          aria-label="Add to playlist"
          className="absolute top-full right-0 z-30 mt-[6px] w-[240px] rounded-[var(--radius-card)] glass p-[8px]"
        >
          <PlaylistPicker nodeId={nodeId} onDone={() => setOpen(false)} />
        </div>
      )}
    </div>
  )
}

/** The playlists to add a track to, and a field to make a new one: the
 * button's popover, and the phone's "more" menu (#389), where `sheet` makes
 * each row and the field 44px. It loads as it mounts, so each open lists
 * what's there now. */
export function PlaylistPicker({ nodeId, onDone, sheet = false }: { nodeId: number; onDone: () => void; sheet?: boolean }) {
  const [playlists, setPlaylists] = useState<PlaylistListItem[] | null>(null)
  const [newName, setNewName] = useState('')
  const [justAdded, setJustAdded] = useState<number | null>(null)
  // An open list loads again after an outage (#119).
  const reconnects = useReconnectEpoch()

  useEffect(() => {
    // Clears the last load's list before refetching, so a stale list can't be clicked.
    // oxlint-disable-next-line react/set-state-in-effect
    setPlaylists(null)
    setJustAdded(null)
    fetch(`${API}/playlists`)
      .then((r) => r.json())
      .then(setPlaylists)
      .catch(() => setPlaylists([]))
  }, [reconnects])

  const addTo = async (playlistId: number) => {
    setJustAdded(playlistId)
    await fetch(`${API}/playlists/${playlistId}/tracks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId }),
    })
    setTimeout(onDone, 500)
  }

  const createAndAdd = async () => {
    const name = newName.trim()
    if (!name) return
    const playlist = (await fetch(`${API}/playlists`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }).then((r) => r.json())) as PlaylistListItem
    setNewName('')
    await addTo(playlist.id)
  }

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
                onClick={() => void addTo(p.id)}
                className={`flex w-full items-center gap-[4px] rounded-[8px] px-[8px] text-left text-[var(--color-ink)] transition-colors duration-150 hover:bg-[var(--color-wash)] ${
                  sheet ? 'h-[44px]' : 'h-[32px]'
                }`}
              >
                <ScrollingText
                  text={p.name}
                  className={`min-w-0 flex-1 ${sheet ? 'text-[length:var(--text-body)]' : 'text-[length:var(--text-secondary)]'}`}
                />
                {justAdded === p.id && <span className="shrink-0 text-small text-[var(--color-ok)]">added</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
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
    </>
  )
}
