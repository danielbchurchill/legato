import { useEffect, useRef } from 'react'
import { API_BASE as API } from '../config/serverHost'
import { withMediaTicket } from '../auth/session'
import type { PlaybackStatus } from './usePlayback'

/* Media Session for the browser player (#128). It's what puts the track on a phone's lock
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

/** An action the browser refused, said out loud (#407: an empty catch here
 * hid why the iPhone's lock screen had no next, previous or scrubber). */
function reportRefusal(action: MediaSessionAction, error: unknown): void {
  console.warn(`[legato] the media session refused "${action}"`, error)
}

/** Points the session's buttons at the player. Returns a cleanup that
 * unhooks them. An action this browser doesn't know (older ones lack
 * seekto) throws from setActionHandler, which costs that one button and
 * nothing else, and is logged.
 *
 * Seeking forward and back are cleared, not left unset: a page with
 * neither gets the browser's own ±10 or ±15 s skip buttons, which can take
 * the place of next and previous on the lock screen.
 *
 * Calling this again re-registers every handler without unhooking any in
 * between, which useMediaSession does each time playback starts (#407). */
export function bindMediaSessionActions(
  session: MediaSessionLike,
  controls: () => MediaSessionControls,
  onSeek: (positionMs: number) => void = () => undefined,
): () => void {
  const handlers: [MediaSessionAction, MediaSessionActionHandler | null][] = [
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
    ['seekbackward', null],
    ['seekforward', null],
  ]
  const bound: MediaSessionAction[] = []
  for (const [action, handler] of handlers) {
    try {
      session.setActionHandler(action, handler)
      if (handler) bound.push(action)
    } catch (error) {
      reportRefusal(action, error)
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

/** Where the lock screen's scrubber sits, and whether it moves. The browser
 * extrapolates from here while playing, so this only needs calling when
 * that extrapolation would go wrong: a new track, play/pause, a seek.
 * Cleared when the length isn't known, since a guessed duration is a
 * scrubber that lies.
 *
 * The playback state is set again after the position, every time: #408's
 * prototype found that without it, the iPhone's lock screen kept its
 * scrubber moving over silence after the audio had stopped. */
export function syncPositionState(
  session: MediaSessionLike,
  { positionMs, durationMs, playing }: { positionMs: number; durationMs: number | null; playing: boolean },
): void {
  if (session.setPositionState) {
    try {
      if (durationMs == null || durationMs <= 0) {
        session.setPositionState()
      } else {
        const duration = durationMs / 1000
        session.setPositionState({ duration, position: Math.min(Math.max(positionMs / 1000, 0), duration), playbackRate: 1 })
      }
    } catch (error) {
      // An out-of-range state throws; the scrubber just keeps its last value.
      console.warn('[legato] the media session refused a position', error)
    }
  }
  session.playbackState = playing ? 'playing' : 'paused'
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
 * with its own status and controls, and the <audio> element they drive. */
export function useMediaSession({
  enabled,
  status,
  title,
  controls,
  element = null,
}: {
  enabled: boolean
  status: PlaybackStatus
  title: string | null
  controls: MediaSessionControls
  element?: EventTarget | null
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

  // #407: the lock screen showed play and pause, but no next, previous or
  // scrubber. WebKit hands the page's actions to the lock screen through
  // an object that exists only while one of the page's media elements has
  // an active media session, and is made empty each time one becomes
  // active (NowPlayingManager in WebKit's source): an action set before
  // then is dropped without an error. These were set once, when the app
  // loaded, before anything had played. #408's prototype set them after
  // play() and its lock screen had all three. So they're set again every
  // time the element starts playing.
  useEffect(() => {
    if (!session) return
    const bind = () =>
      bindMediaSessionActions(
        session,
        () => controlsRef.current,
        (positionMs) =>
          syncPositionState(session, {
            positionMs,
            durationMs: statusRef.current.currentDurationMs,
            playing: statusRef.current.playing,
          }),
      )
    const unbind = bind()
    const onPlaying = () => {
      bind()
      const { positionMs, currentDurationMs } = statusRef.current
      syncPositionState(session, { positionMs, durationMs: currentDurationMs, playing: true })
    }
    element?.addEventListener('playing', onPlaying)
    return () => {
      element?.removeEventListener('playing', onPlaying)
      unbind()
    }
  }, [session, element])

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
    syncPositionState(session, { positionMs: statusRef.current.positionMs, durationMs, playing })
  }, [session, nodeId, playing, durationMs])
}
