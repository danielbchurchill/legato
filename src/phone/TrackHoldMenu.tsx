import { useEffect, useState, type RefObject } from 'react'
import { Popover } from '../ui/Popover'
import { PlaylistPicker } from '../panels/AddToPlaylistButton'
import { API } from '../panels/useNodeDetail'
import { enqueueItem } from '../search/searchData'
import type { usePlayback } from '../playback/usePlayback'
import { MenuItem } from './MenuItem'

/* The menu a held track row opens on the phone (#447): add to queue, add
 * to playlist and go to album, in the rows node detail's "more" uses, with
 * add to playlist turning the menu into the same playlist picker. It hangs
 * from the held row, which is washed while the menu is open so it's clear
 * which track it's for.
 *
 * A row names its track with `data-hold-track` and, where the list knows
 * it, its album with `data-hold-album`. Where it doesn't (a producer's
 * tracks), the track itself is asked as the menu opens. A list that is an
 * album's own tracks has nowhere else for go to album to go, so it leaves
 * it out. */

type Playback = ReturnType<typeof usePlayback>

export type HeldTrack = { nodeId: number; albumId: number | null }

/* The album a track is on, from the track's own edges. */
async function albumOfTrack(nodeId: number): Promise<number | null> {
  const response = await fetch(`${API}/nodes/${nodeId}`)
  if (!response.ok) return null
  const node = (await response.json()) as { edges?: { type: string; direction: string; other_id: number }[] }
  return node.edges?.find((e) => e.type === 'appears_on' && e.direction === 'out')?.other_id ?? null
}

export function TrackHoldMenu({
  held,
  anchorRef,
  onClose,
  playback,
  onOpenNode,
  showAlbum,
}: {
  held: HeldTrack
  anchorRef: RefObject<HTMLElement | null>
  onClose: () => void
  playback: Playback
  onOpenNode: (id: number) => void
  showAlbum: boolean
}) {
  const [picking, setPicking] = useState(false)
  const [albumId, setAlbumId] = useState(held.albumId)

  useEffect(() => {
    if (!showAlbum || held.albumId != null) return
    let cancelled = false
    albumOfTrack(held.nodeId)
      .then((id) => !cancelled && setAlbumId(id))
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [held, showAlbum])

  return (
    <Popover
      label={picking ? 'Add to playlist' : 'Track'}
      anchorRef={anchorRef}
      placement="bottom"
      align="end"
      className="w-[240px] p-[6px]"
      open
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      {(close) =>
        picking ? (
          <PlaylistPicker nodeId={held.nodeId} onDone={close} sheet />
        ) : (
          <ul className="flex flex-col">
            <MenuItem
              onClick={() => {
                void enqueueItem({ kind: 'recording', id: held.nodeId }, playback)
                close()
              }}
            >
              add to queue
            </MenuItem>
            <MenuItem onClick={() => setPicking(true)}>add to playlist</MenuItem>
            {showAlbum && (
              <MenuItem
                disabled={albumId == null}
                onClick={() => {
                  if (albumId == null) return
                  close()
                  onOpenNode(albumId)
                }}
              >
                go to album
              </MenuItem>
            )}
          </ul>
        )
      }
    </Popover>
  )
}
