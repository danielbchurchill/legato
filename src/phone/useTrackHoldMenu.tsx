import { useRef, useState, type ReactNode } from 'react'
import type { usePlayback } from '../playback/usePlayback'
import { TrackHoldMenu, type HeldTrack } from './TrackHoldMenu'
import { useTrackHold } from './trackHold'

type TrackHoldMenuOptions = {
  playback: ReturnType<typeof usePlayback>
  onOpenNode: (id: number) => void
  /** The album the list belongs to, when it's an album's own tracks. */
  ownAlbumId?: number | null
}

/** The data attributes a holdable track row carries: its track, and its
 * album where the list knows it. */
export function holdRowProps(nodeId: number, albumId?: number | null): Record<string, string> {
  return { 'data-hold-track': String(nodeId), ...(albumId != null ? { 'data-hold-album': String(albumId) } : {}) }
}

/** Wires a phone track list for holds (#447): put `holdRef` on the list,
 * `holdRowProps` on each row, and render `menu` anywhere beside it. The
 * held row carries `data-held` while its menu is open. */
export function useTrackHoldMenu({ playback, onOpenNode, ownAlbumId = null }: TrackHoldMenuOptions): {
  holdRef: (list: HTMLElement | null) => (() => void) | undefined
  menu: ReactNode
} {
  const [held, setHeld] = useState<HeldTrack | null>(null)
  const anchorRef = useRef<HTMLElement | null>(null)
  const holdRef = useTrackHold((row) => {
    anchorRef.current?.removeAttribute('data-held')
    row.setAttribute('data-held', '')
    anchorRef.current = row
    const album = row.dataset.holdAlbum
    setHeld({ nodeId: Number(row.dataset.holdTrack), albumId: album ? Number(album) : null })
  })
  const close = () => {
    anchorRef.current?.removeAttribute('data-held')
    setHeld(null)
  }
  const menu =
    held == null ? null : (
      <TrackHoldMenu
        key={held.nodeId}
        held={held}
        anchorRef={anchorRef}
        onClose={close}
        playback={playback}
        onOpenNode={onOpenNode}
        showAlbum={ownAlbumId == null}
      />
    )
  return { holdRef, menu }
}
