import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useEffect, useRef } from 'react'
import { API_BASE as API } from '../config/serverHost'
import { coverUrl, readArtistAndAlbum, type MediaSessionControls } from './mediaSession'
import type { PlaybackStatus } from './usePlayback'

/* Media keys, headphone and AirPods buttons, and the OS's now-playing
 * widget for native playback (#131): souvlaki in src-tauri/src/
 * media_controls.rs, which is macOS's Now Playing, Windows' SMTC and
 * Linux's MPRIS. The browser player's counterpart is mediaSession.ts.
 *
 * Both ways go through here, because this side owns the queue: Rust holds
 * only the next track or two, so it can't go back a track, and under
 * repeat-one it holds only the track it loops.
 * - A button pressed in the OS arrives as playback://media-control, and
 *   runs the same play, pause, next, previous, seek or stop as the
 *   transport, which call playback.rs's commands.
 * - What the transport shows goes to the OS: the track as
 *   playback://track-changed moves it, and play, pause and the position.
 *
 * The cover goes as its URL with the media ticket. The shell fetches it and
 * hands the OS a file instead, so the ticket never leaves the app. */

/** What a button pressed in the OS asks for. Mirrors media_controls.rs's
 * MediaControl, whose a_control_serializes_as_an_action_tagged_object test
 * pins the Rust side. */
export type NativeMediaControl =
  | { action: 'play' | 'pause' | 'toggle' | 'next' | 'previous' | 'stop' }
  | { action: 'seek'; position_ms: number }
  | { action: 'seek_by'; offset_ms: number }

export type NativeMediaControls = MediaSessionControls & { stop: () => unknown }

type Where = Pick<PlaybackStatus, 'playing' | 'positionMs' | 'currentDurationMs'>

// Inside the track: a seek past either end lands on it.
function within(positionMs: number, durationMs: number | null): number {
  const capped = durationMs != null && durationMs > 0 ? Math.min(positionMs, durationMs) : positionMs
  return Math.max(0, capped)
}

/** Runs one button press against the player. */
export function runMediaControl(control: NativeMediaControl, controls: NativeMediaControls, now: Where): void {
  switch (control.action) {
    case 'play':
      void controls.play()
      return
    case 'pause':
      void controls.pause()
      return
    case 'toggle':
      void (now.playing ? controls.pause() : controls.play())
      return
    case 'next':
      void controls.next()
      return
    case 'previous':
      void controls.previous()
      return
    case 'stop':
      void controls.stop()
      return
    case 'seek':
      void controls.seek(within(control.position_ms, now.currentDurationMs))
      return
    case 'seek_by':
      void controls.seek(within(now.positionMs + control.offset_ms, now.currentDurationMs))
      return
  }
}

/** How far the transport's position can stray from where the OS would have
 * it before the OS is told again. Positions arrive four times a second. */
export const DRIFT_MS = 1500

export type Synced = { nodeId: number; playing: boolean; positionMs: number; at: number }

/** Whether the OS needs telling where playback is. It moves the position on
 * by itself while playing, so only a new track, play or pause, or a
 * position its count has strayed from (a seek, a restart) needs saying. */
export function needsSync(last: Synced | null, next: Omit<Synced, 'at'>, now: number): boolean {
  if (!last || last.nodeId !== next.nodeId || last.playing !== next.playing) return true
  const expected = last.positionMs + (last.playing ? now - last.at : 0)
  return Math.abs(next.positionMs - expected) > DRIFT_MS
}

type Edges = { nodeId: number; artist: string; album: string }

/** Keeps the OS's media controls in step with native playback. Called from
 * App with usePlayback's status, title and controls. */
export function useNativeMediaControls({
  enabled,
  status,
  title,
  controls,
}: {
  enabled: boolean
  status: PlaybackStatus
  title: string | null
  controls: NativeMediaControls
}): void {
  // Read through refs, so the listener is set up once rather than again on
  // every position tick.
  const controlsRef = useRef(controls)
  const statusRef = useRef(status)
  const titleRef = useRef(title)
  useEffect(() => {
    controlsRef.current = controls
    statusRef.current = status
    titleRef.current = title
  })

  useEffect(() => {
    if (!enabled) return
    const unlisten = listen<NativeMediaControl>('playback://media-control', (e) => {
      // macOS keeps sending the keys to the app that last played. With
      // nothing in the transport, not even a track that failed to start
      // (which keeps its title), there's nothing for them to do, and play
      // would mark the player playing with nothing in it.
      if (statusRef.current.currentRecordingNodeId == null && titleRef.current == null) return
      runMediaControl(e.payload, controlsRef.current, statusRef.current)
    }).catch(() => undefined)
    return () => {
      void unlisten.then((f) => f?.())
    }
  }, [enabled])

  const nodeId = status.currentRecordingNodeId
  const durationMs = status.currentDurationMs
  // The track's artist and album, kept while it plays, so a later title
  // doesn't blank them while they're fetched again.
  const edges = useRef<Edges | null>(null)
  useEffect(() => {
    if (!enabled) return
    if (nodeId == null) {
      void invoke('media_controls_clear').catch(() => undefined)
      return
    }
    const send = ({ artist, album }: { artist: string; album: string }) =>
      void invoke('media_controls_set_track', {
        track: {
          recording_node_id: nodeId,
          title: title ?? '',
          artist,
          album,
          duration_ms: durationMs,
          cover_url: coverUrl(nodeId, 'full'),
        },
      }).catch(() => undefined)
    const known = edges.current?.nodeId === nodeId ? edges.current : null
    // The title at once, and the artist and album when the recording's
    // edges arrive, as mediaSession.ts does on the lock screen.
    send(known ?? { artist: '', album: '' })
    if (known) return
    let cancelled = false
    fetch(`${API}/nodes/${nodeId}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((node) => {
        if (cancelled || !node) return
        edges.current = { nodeId, ...readArtistAndAlbum(node) }
        send(edges.current)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [enabled, nodeId, title, durationMs])

  const synced = useRef<Synced | null>(null)
  const playing = status.playing
  const positionMs = status.positionMs
  useEffect(() => {
    if (!enabled || nodeId == null) {
      synced.current = null
      return
    }
    const next = { nodeId, playing, positionMs }
    const now = performance.now()
    if (!needsSync(synced.current, next, now)) return
    synced.current = { ...next, at: now }
    void invoke('media_controls_set_playback', { recordingNodeId: nodeId, playing, positionMs }).catch(() => undefined)
  }, [enabled, nodeId, playing, positionMs])
}
