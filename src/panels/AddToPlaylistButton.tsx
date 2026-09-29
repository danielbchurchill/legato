import { useEffect, useRef, useState } from 'react'
import { Icon } from '../ui/Icon'
import { ScrollingText } from '../ui/ScrollingText'
import { Tooltip } from '../ui/Tooltip'
import { API_BASE as API } from '../config/serverHost'

type PlaylistListItem = { id: number; name: string; track_count: number }

/* The one write path from a track row into a playlist besides the playlist
 * detail view's own reordering (Playlists.tsx). A click-to-open popover on
 * the same glass recipe as Popover.tsx (C-1), not a Popover itself — that
 * component's job is a static info blurb, this one fetches, lists, and
 * submits. Fetches fresh every time it opens rather than subscribing to
 * playlist:changed — it's a few-hundred-ms-lived popover, not a standing
 * surface, so there's nothing to keep in sync between opens. */
export function AddToPlaylistButton({ nodeId, size = 24 }: { nodeId: number; size?: number }) {
  const [open, setOpen] = useState(false)
  const [playlists, setPlaylists] = useState<PlaylistListItem[] | null>(null)
  const [newName, setNewName] = useState('')
  const [justAdded, setJustAdded] = useState<number | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    setPlaylists(null)
    setJustAdded(null)
    fetch(`${API}/playlists`)
      .then((r) => r.json())
      .then(setPlaylists)
      .catch(() => setPlaylists([]))
  }, [open])

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
      <Tooltip label="Add to playlist">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label="Add to playlist"
          aria-expanded={open}
          className="shrink-0 text-[var(--color-muted)] transition-colors duration-150 hover:text-[var(--color-muted-hi)]"
        >
          <Icon name="add" size={size} />
        </button>
      </Tooltip>
      {open && (
        <div
          role="dialog"
          aria-label="Add to playlist"
          className="absolute top-full right-0 z-30 mt-[6px] w-[220px] rounded-[var(--radius-surface)] border border-[var(--color-hairline)] bg-[var(--color-surface)] p-[12px] backdrop-blur-[var(--blur-glass)] shadow-[var(--shadow-surface)]"
        >
          {playlists === null ? (
            <p className="text-[length:var(--text-base)] text-[var(--color-muted)]">loading…</p>
          ) : playlists.length === 0 ? (
            <p className="text-[length:var(--text-base)] text-[var(--color-muted)]">no playlists yet</p>
          ) : (
            <ul className="flex max-h-[180px] flex-col overflow-y-auto">
              {playlists.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => void addTo(p.id)}
                    className="flex w-full items-baseline gap-[4px] py-[4px] text-left text-[var(--color-ink)] transition-colors duration-150 hover:text-[var(--color-muted-hi)]"
                  >
                    <ScrollingText text={p.name} className="min-w-0 flex-1 text-[length:var(--text-base)]" />
                    {justAdded === p.id && <span className="shrink-0 text-[length:var(--text-base)] text-[var(--color-muted)]">added</span>}
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
            className="mt-[8px] flex items-center gap-[6px] border-t border-[var(--color-divider)] pt-[8px]"
          >
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="new playlist…"
              aria-label="New playlist name"
              className="min-w-0 flex-1 bg-transparent text-[length:var(--text-base)] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-muted)]"
            />
            <button
              type="submit"
              aria-label="Create playlist and add"
              className="shrink-0 text-[var(--color-muted)] transition-colors duration-150 hover:text-[var(--color-muted-hi)]"
            >
              <Icon name="add" size={16} />
            </button>
          </form>
        </div>
      )}
    </div>
  )
}
