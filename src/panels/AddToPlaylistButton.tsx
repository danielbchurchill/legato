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
  const [playlists, setPlaylists] = useState<PlaylistListItem[] | null>(null)
  const [newName, setNewName] = useState('')
  const [justAdded, setJustAdded] = useState<number | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  // An open list loads again after an outage (#119).
  const reconnects = useReconnectEpoch()

  useEffect(() => {
    if (!open) return
    // Clears the last open's list before refetching, so a stale list can't be clicked.
    // oxlint-disable-next-line react/set-state-in-effect
    setPlaylists(null)
    setJustAdded(null)
    fetch(`${API}/playlists`)
      .then((r) => r.json())
      .then(setPlaylists)
      .catch(() => setPlaylists([]))
  }, [open, reconnects])

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

  const addTo = async (playlistId: number) => {
    setJustAdded(playlistId)
    await fetch(`${API}/playlists/${playlistId}/tracks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId }),
    })
    setTimeout(() => setOpen(false), 500)
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
    <div ref={rootRef} className="relative inline-flex">
      <IconButton icon="add" label="Add to playlist" size={size} active={open} aria-expanded={open} onClick={() => setOpen((v) => !v)} />
      {open && (
        <div
          role="dialog"
          aria-label="Add to playlist"
          className="absolute top-full right-0 z-30 mt-[6px] w-[240px] rounded-[var(--radius-card)] glass p-[8px]"
        >
          {playlists === null ? (
            <p className="text-[length:var(--text-secondary)] text-[var(--color-ink-3)]">loading…</p>
          ) : playlists.length === 0 ? (
            <p className="text-[length:var(--text-secondary)] text-[var(--color-ink-3)]">No playlists yet</p>
          ) : (
            <ul className="flex max-h-[180px] flex-col overflow-y-auto">
              {playlists.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => void addTo(p.id)}
                    className="flex h-[32px] w-full items-center gap-[4px] rounded-[8px] px-[8px] text-left text-[var(--color-ink)] transition-colors duration-150 hover:bg-[var(--color-wash)]"
                  >
                    <ScrollingText text={p.name} className="min-w-0 flex-1 text-[length:var(--text-secondary)]" />
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
              value={newName}
              onChange={setNewName}
              placeholder="New playlist…"
              label="New playlist name"
              className="flex-1"
            />
            <IconButton icon="add" label="Create playlist and add" onClick={() => void createAndAdd()} />
          </form>
        </div>
      )}
    </div>
  )
}
