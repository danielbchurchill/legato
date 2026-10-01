import { useEffect, useRef } from 'react'
import { API_BASE as API } from '../config/serverHost'
import { withMediaTicket } from '../auth/session'
import type { PlaybackStatus } from './usePlayback'

/* Media Session for the browser player (#128, docs/plans/07-clients.md
 * "Installable web app (G16)"). It's what puts the track on a phone's lock
 * screen and routes the headphone and lock-screen buttons back into the
 * queue. This is Rowan's Android client until there are mobile apps.
 *
 * Browser path only. The Tauri webview's playback is native Rust, and
 * native media keys there are #131's (souvlaki against playback.rs), so
 * usePlayback passes enabled: false inside Tauri.
 *
 * Everything that touches the session takes it as an argument, so
 * mediaSession.spec.ts can drive the wiring with a fake one. */

/** The subset of navigator.mediaSession used here. */
export type MediaSessionLike = {
  metadata: MediaMetadata | null
  playbackState: MediaSessionPlaybackState
  setActionHandler(action: MediaSessionAction, handler: MediaSessionActionHandler | null): void
  setPositionState?(state?: MediaPositionState): void
}

export type MediaSessionControls = {
  play: () => unknown
  pause: () => unknown
  next: () => unknown
  previous: () => unknown
  seek: (positionMs: number) => unknown
}

export type TrackMetadata = { title: string; artist: string; album: string; artwork: MediaImage[] }

/** The cover at both of the server's cached sizes (DESIGN.md "Cover art
 * cache"), so the OS picks whichever suits its widget. Through
 * /nodes/:id/cover, with the media ticket, the same URL CoverArt.tsx uses:
 * an artwork fetch can't send a bearer header. */
export function artworkFor(recordingNodeId: number): MediaImage[] {
  const cover = (size: 'thumb' | 'full') => withMediaTicket(`${API}/nodes/${recordingNodeId}/cover?size=${size}`)
  return [
    { src: cover('thumb'), sizes: '256x256', type: 'image/jpeg' },
    { src: cover('full'), sizes: '512x512', type: 'image/jpeg' },
  ]
}

type NodeEdges = { edges?: { direction: string; type: string; other_title?: string | null }[] }

/** Artist and album off a recording's GET /nodes/:id, the same edges
 * NodeTitleBlock.tsx reads. Empty strings when a loose file has neither. */
export function readArtistAndAlbum(node: NodeEdges): { artist: string; album: string } {
  const out = (type: string) => node.edges?.find((e) => e.direction === 'out' && e.type === type)?.other_title ?? ''
  return { artist: out('performed_by'), album: out('appears_on') }
}

/** Points the session's buttons at the player. Returns a cleanup that
 * unhooks them. An action this browser doesn't know (older ones lack
 * seekto) throws from setActionHandler, which costs that one button and
 * nothing else. */
export function bindMediaSessionActions(
  session: MediaSessionLike,
  controls: () => MediaSessionControls,
  onSeek: (positionMs: number) => void = () => undefined,
): () => void {
  const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
    ['play', () => void controls().play()],
    ['pause', () => void controls().pause()],
    ['nexttrack', () => void controls().next()],
    ['previoustrack', () => void controls().previous()],
    [
      'seekto',
      (details) => {
        if (details.seekTime == null) return
        const positionMs = details.seekTime * 1000
        void controls().seek(positionMs)
        onSeek(positionMs)
      },
    ],
  ]
  const bound: MediaSessionAction[] = []
  for (const [action, handler] of handlers) {
    try {
      session.setActionHandler(action, handler)
      bound.push(action)
    } catch {
      // Unsupported action; see above.
    }
  }
  return () => {
    for (const action of bound) {
      try {
        session.setActionHandler(action, null)
      } catch {
        // Already gone.
      }
    }
  }
}

/** Where the lock screen's scrubber sits. The browser extrapolates from
 * here while playing, so this only needs calling when that extrapolation
 * would go wrong: a new track, play/pause, a seek. Cleared when the length
 * isn't known, since a guessed duration is a scrubber that lies. */
export function syncPositionState(
  session: MediaSessionLike,
  { positionMs, durationMs }: { positionMs: number; durationMs: number | null },
): void {
  if (!session.setPositionState) return
  try {
    if (durationMs == null || durationMs <= 0) {
      session.setPositionState()
      return
    }
    const duration = durationMs / 1000
    session.setPositionState({ duration, position: Math.min(Math.max(positionMs / 1000, 0), duration), playbackRate: 1 })
  } catch {
    // An out-of-range state throws; the scrubber just keeps its last value.
  }
}

type MetadataFactory = (init: MediaMetadataInit) => MediaMetadata

/** Shows `track` on the session, or clears it when nothing is current. */
export function applyMetadata(
  session: MediaSessionLike,
  track: TrackMetadata | null,
  createMetadata: MetadataFactory = (init) => new MediaMetadata(init),
): void {
  session.metadata = track ? createMetadata(track) : null
  if (!track) session.playbackState = 'none'
}

function currentSession(): MediaSessionLike | null {
  return typeof navigator !== 'undefined' && 'mediaSession' in navigator ? navigator.mediaSession : null
}

/** Keeps the session in step with the web player. Called from usePlayback
 * with its own status and controls. */
export function useMediaSession({
  enabled,
  status,
  title,
  controls,
}: {
  enabled: boolean
  status: PlaybackStatus
  title: string | null
  controls: MediaSessionControls
}): void {
  // The controls are new functions whenever usePlayback's callbacks change;
  // the handlers read them through this ref so they're bound once, not
  // re-bound on every change.
  const controlsRef = useRef(controls)
  const statusRef = useRef(status)
  useEffect(() => {
    controlsRef.current = controls
    statusRef.current = status
  })

  const session = enabled ? currentSession() : null

  useEffect(() => {
    if (!session) return
    return bindMediaSessionActions(
      session,
      () => controlsRef.current,
      (positionMs) => syncPositionState(session, { positionMs, durationMs: statusRef.current.currentDurationMs }),
    )
  }, [session])

  const nodeId = status.currentRecordingNodeId
  useEffect(() => {
    if (!session) return
    if (nodeId == null) {
      applyMetadata(session, null)
      return
    }
    const artwork = artworkFor(nodeId)
    const trackTitle = title ?? ''
    // Title and cover at once, from what the player already has; artist and
    // album when the node's edges arrive. A lock screen showing just the
    // title for a moment beats one showing the previous track.
    applyMetadata(session, { title: trackTitle, artist: '', album: '', artwork })
    let cancelled = false
    fetch(`${API}/nodes/${nodeId}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((node: NodeEdges | null) => {
        if (cancelled || !node) return
        applyMetadata(session, { title: trackTitle, ...readArtistAndAlbum(node), artwork })
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [session, nodeId, title])

  const playing = status.playing
  const durationMs = status.currentDurationMs
  useEffect(() => {
    if (!session || nodeId == null) return
    session.playbackState = playing ? 'playing' : 'paused'
    syncPositionState(session, { positionMs: statusRef.current.positionMs, durationMs })
  }, [session, nodeId, playing, durationMs])
}
