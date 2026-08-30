import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { SERVER_HOST } from '../config/serverHost'
import { IS_TAURI } from '../config/runtime'

const API = `http://${SERVER_HOST}:8899/api/v1`

type ResolvedTrack = {
  recordingNodeId: number
  fileId: number
  filePath: string
  format: string | null
  bitrate: number | null
  durationMs: number | null
  replaygainTrackGain: number | null
  replaygainAlbumGain: number | null
}

export type QueueEntry = { recordingNodeId: number; title: string; durationMs: number | null }
export type ReplayGainMode = 'track' | 'album' | 'off'

// 'album' falls back to track gain when a recording's release has none
// (an untagged single, a compilation with mixed source masters) — "no
// adjustment at all" is a worse default than "adjust some other way" for
// what a ReplayGain mode is actually for: consistent loudness across a
// mixed queue.
function gainForMode(
  track: { replaygainTrackGain: number | null; replaygainAlbumGain: number | null },
  mode: ReplayGainMode,
): number | null {
  if (mode === 'off') return null
  if (mode === 'album') return track.replaygainAlbumGain ?? track.replaygainTrackGain
  return track.replaygainTrackGain
}

export type PlaybackStatus = {
  playing: boolean
  positionMs: number
  currentRecordingNodeId: number | null
  /** The file backing the current recording — TransportDock's waveform
   * scrubber fetches peaks by file id, not recording id. */
  currentFileId: number | null
  currentDurationMs: number | null
  volume: number
}

// What a play-in-progress needs to report itself to POST /api/v1/plays once
// it ends — lastPositionMs is the scrobble candidate's ms_played, updated
// on every playback://position tick rather than computed from wall-clock
// time, so a paused track doesn't accrue phantom listening time.
type PlayInProgress = {
  recordingNodeId: number
  fileId: number
  startedAt: string
  lastPositionMs: number
}

async function resolveTracks(recordingNodeIds: number[]): Promise<ResolvedTrack[]> {
  const res = await fetch(`${API}/queue/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recordingNodeIds }),
  })
  const data = await res.json()
  return (data.tracks as (ResolvedTrack | null)[]).filter((t): t is ResolvedTrack => t != null)
}

type NodeDetail = { title: string; edges: { direction: 'in' | 'out'; type: string; other_id: number }[] }
type TracklistEntry = { id: number; title: string; track_no: number | null; canonical_duration_ms: number | null }

// A single click on a track queues the rest of its album, in album order —
// not just that one track. Loose files with no release (or a release with
// no other tracks after this one) queue alone, same as before.
async function resolveQueueContext(recordingNodeId: number, fallbackTitle: string): Promise<QueueEntry[]> {
  try {
    const node = (await fetch(`${API}/nodes/${recordingNodeId}`).then((r) => r.json())) as NodeDetail
    const releaseEdge = node.edges.find((e) => e.direction === 'out' && e.type === 'appears_on')
    if (!releaseEdge) return [{ recordingNodeId, title: node.title, durationMs: null }]

    const tracklist = (await fetch(`${API}/nodes/${releaseEdge.other_id}/tracklist`).then((r) =>
      r.json(),
    )) as TracklistEntry[]
    const startIndex = tracklist.findIndex((t) => t.id === recordingNodeId)
    if (startIndex === -1) return [{ recordingNodeId, title: node.title, durationMs: null }]

    return tracklist
      .slice(startIndex)
      .map((t) => ({ recordingNodeId: t.id, title: t.title, durationMs: t.canonical_duration_ms }))
  } catch {
    // Context resolution is an enhancement, not a requirement — a network
    // hiccup here shouldn't block playing the one track the user clicked.
    return [{ recordingNodeId, title: fallbackTitle, durationMs: null }]
  }
}

// Server applies the scrobble threshold (server/src/plays/scrobble.ts) and
// silently no-ops a report that doesn't qualify — this always fires on
// every track boundary and lets the server decide what counts as a play.
function reportPlay(entry: PlayInProgress): void {
  if (entry.lastPositionMs <= 0) return
  fetch(`${API}/plays`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileId: entry.fileId, startedAt: entry.startedAt, msPlayed: entry.lastPositionMs }),
  }).catch(() => undefined)
}

// In Tauri, talks to the Rust playback engine (src-tauri/src/playback.rs) via
// IPC, never the server directly for audio — decode + gapless scheduling +
// device output all live in Rust, per Legato's platform split. Outside Tauri
// (IS_TAURI false — a plain browser tab, e.g. the web preview from `npm run
// dev:remote`), invoke()/listen() have no IPC bridge to talk to and would
// reject, so this branches to a plain HTML5 <audio> element pointed at the
// server's GET /api/v1/files/:id/stream transcode route instead — not
// gapless, but that's exactly the "no native decode option" case the stream
// route was built for (see CLAUDE.md's Development Conventions). Both paths
// present the same play/pause/seek/skip/queue interface below so the rest of
// the app doesn't care which backend is live underneath.
export function usePlayback(replaygainMode: ReplayGainMode = 'track') {
  const [status, setStatus] = useState<PlaybackStatus>({
    playing: false,
    positionMs: 0,
    currentRecordingNodeId: null,
    currentFileId: null,
    currentDurationMs: null,
    volume: 1,
  })
  const [currentTitle, setCurrentTitle] = useState<string | null>(null)
  const [upNext, setUpNext] = useState<QueueEntry[]>([])

  // fileId/durationMs per recording node, populated by playNode's own
  // resolveTracks() call — the only place a recordingNodeId maps to the
  // fileId a play report needs. queueContext is the full ordered context
  // (the whole album, from the clicked track on) resolved at play time;
  // track-changed slices it to derive up-next as the queue advances,
  // rather than re-resolving context on every boundary. Both are refs, not
  // state, since neither should trigger a re-render on every 250ms
  // position tick.
  const trackInfo = useRef(new Map<number, { fileId: number; durationMs: number | null }>())
  const queueContext = useRef<QueueEntry[]>([])
  const currentPlay = useRef<PlayInProgress | null>(null)

  // Web-fallback-only: the single <audio> element standing in for Rust's
  // queue, and which slot of queueContext it's currently playing. Lazy
  // singleton construction during render (not an effect) is the standard
  // pattern for a one-time DOM object a ref should own for the component's
  // whole lifetime — see React's docs on creating objects lazily.
  const audioRef = useRef<HTMLAudioElement | null>(null)
  if (!IS_TAURI && audioRef.current === null) audioRef.current = new Audio()
  const webQueueIndex = useRef(0)

  const finalizeCurrentPlay = useCallback(() => {
    if (currentPlay.current) reportPlay(currentPlay.current)
    currentPlay.current = null
  }, [])

  // Advances the web-fallback player to queueContext[index] — walking off
  // the end mirrors the Tauri path's playback://track-changed(null) case,
  // clearing now-playing state instead of looping or erroring.
  const startWebTrack = useCallback(
    (index: number) => {
      const audio = audioRef.current
      if (!audio) return
      const entry = queueContext.current[index]
      if (!entry) {
        finalizeCurrentPlay()
        audio.pause()
        webQueueIndex.current = index
        setCurrentTitle(null)
        setUpNext([])
        setStatus((s) => ({ ...s, playing: false, currentRecordingNodeId: null, currentFileId: null, currentDurationMs: null }))
        return
      }
      const info = trackInfo.current.get(entry.recordingNodeId)
      if (!info) {
        startWebTrack(index + 1)
        return
      }

      finalizeCurrentPlay()
      webQueueIndex.current = index
      currentPlay.current = {
        recordingNodeId: entry.recordingNodeId,
        fileId: info.fileId,
        startedAt: new Date().toISOString(),
        lastPositionMs: 0,
      }
      audio.src = `${API}/files/${info.fileId}/stream`
      // A missing/unreadable source file or a format ffmpeg can't
      // transcode surfaces here as a rejected play() (confirmed live:
      // NotSupportedError against a file the server's own ffmpeg spawn
      // failed to open) — reflect that honestly rather than leaving an
      // unhandled rejection and a UI that still claims "playing".
      audio.play().catch(() => setStatus((s) => ({ ...s, playing: false })))
      setCurrentTitle(entry.title)
      setUpNext(queueContext.current.slice(index + 1))
      setStatus((s) => ({
        ...s,
        playing: true,
        currentRecordingNodeId: entry.recordingNodeId,
        currentFileId: info.fileId,
        currentDurationMs: info.durationMs,
      }))
    },
    [finalizeCurrentPlay],
  )

  // Web-fallback event wiring — <audio>'s own timeupdate/ended replace the
  // playback://position and playback://track-changed events Rust emits.
  useEffect(() => {
    if (IS_TAURI) return
    const audio = audioRef.current
    if (!audio) return

    const onTimeUpdate = () => {
      const positionMs = audio.currentTime * 1000
      setStatus((s) => ({ ...s, positionMs }))
      if (currentPlay.current) currentPlay.current.lastPositionMs = positionMs
    }
    const onEnded = () => startWebTrack(webQueueIndex.current + 1)

    audio.addEventListener('timeupdate', onTimeUpdate)
    audio.addEventListener('ended', onEnded)
    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate)
      audio.removeEventListener('ended', onEnded)
    }
  }, [startWebTrack])

  useEffect(() => {
    if (!IS_TAURI) return
    invoke<{ volume: number }>('queue_status')
      .then((s) => setStatus((prev) => ({ ...prev, volume: s.volume })))
      .catch(() => undefined)

    const unlistenPosition = listen<{ position_ms: number; recording_node_id: number | null }>(
      'playback://position',
      (e) => {
        setStatus((s) => ({ ...s, positionMs: e.payload.position_ms, currentRecordingNodeId: e.payload.recording_node_id }))
        if (currentPlay.current && currentPlay.current.recordingNodeId === e.payload.recording_node_id) {
          currentPlay.current.lastPositionMs = e.payload.position_ms
        }
      },
    ).catch(() => undefined)

    const unlistenTrackChanged = listen<{ recording_node_id: number | null }>('playback://track-changed', (e) => {
      finalizeCurrentPlay()

      const nodeId = e.payload.recording_node_id
      if (nodeId != null) {
        const info = trackInfo.current.get(nodeId)
        currentPlay.current = info
          ? { recordingNodeId: nodeId, fileId: info.fileId, startedAt: new Date().toISOString(), lastPositionMs: 0 }
          : null
        setStatus((s) => ({
          ...s,
          currentRecordingNodeId: nodeId,
          currentFileId: info?.fileId ?? null,
          currentDurationMs: info?.durationMs ?? null,
        }))

        const index = queueContext.current.findIndex((t) => t.recordingNodeId === nodeId)
        setUpNext(index === -1 ? [] : queueContext.current.slice(index + 1))

        fetch(`${API}/nodes/${nodeId}`)
          .then((r) => r.json())
          .then((n) => setCurrentTitle(n.title))
      } else {
        setCurrentTitle(null)
        setUpNext([])
        setStatus((s) => ({ ...s, playing: false, currentRecordingNodeId: null, currentFileId: null, currentDurationMs: null }))
      }
    }).catch(() => undefined)

    return () => {
      unlistenPosition.then((f) => f?.())
      unlistenTrackChanged.then((f) => f?.())
    }
  }, [finalizeCurrentPlay])

  const playNode = useCallback(
    async (recordingNodeId: number, title: string) => {
      const context = await resolveQueueContext(recordingNodeId, title)
      const tracks = await resolveTracks(context.map((c) => c.recordingNodeId))
      if (tracks.length === 0) return

      for (const t of tracks) trackInfo.current.set(t.recordingNodeId, { fileId: t.fileId, durationMs: t.durationMs })
      // Context can outrun what actually resolved to a real file (a queued
      // track whose file went missing since the album was last scanned) —
      // up-next should only ever show what will really play.
      const resolvedIds = new Set(tracks.map((t) => t.recordingNodeId))
      queueContext.current = context.filter((c) => resolvedIds.has(c.recordingNodeId))

      if (!IS_TAURI) {
        startWebTrack(0)
        return
      }

      finalizeCurrentPlay()
      await invoke('queue_stop')
      for (const t of tracks) {
        await invoke('queue_enqueue', {
          track: {
            file_path: t.filePath,
            recording_node_id: t.recordingNodeId,
            // Rust just applies whatever dB value arrives here — the mode
            // selection (track/album/off) is entirely a frontend decision
            // about *which* precomputed gain to send, not something the
            // audio engine needs to know about.
            replaygain_track_gain: gainForMode(t, replaygainMode),
          },
        })
      }
      await invoke('queue_play')
      setCurrentTitle(title)
      setUpNext(queueContext.current.slice(1))
      setStatus((s) => ({ ...s, playing: true, currentRecordingNodeId: recordingNodeId }))
    },
    [finalizeCurrentPlay, replaygainMode, startWebTrack],
  )

  const pause = useCallback(async () => {
    if (IS_TAURI) await invoke('queue_pause')
    else audioRef.current?.pause()
    setStatus((s) => ({ ...s, playing: false }))
  }, [])

  const resume = useCallback(async () => {
    if (IS_TAURI) {
      await invoke('queue_play')
      setStatus((s) => ({ ...s, playing: true }))
      return
    }
    try {
      await audioRef.current?.play()
      setStatus((s) => ({ ...s, playing: true }))
    } catch {
      setStatus((s) => ({ ...s, playing: false }))
    }
  }, [])

  const stop = useCallback(async () => {
    finalizeCurrentPlay()
    if (IS_TAURI) {
      await invoke('queue_stop')
    } else if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.removeAttribute('src')
      audioRef.current.load()
    }
    queueContext.current = []
    setUpNext([])
    setStatus({
      playing: false,
      positionMs: 0,
      currentRecordingNodeId: null,
      currentFileId: null,
      currentDurationMs: null,
      volume: status.volume,
    })
    setCurrentTitle(null)
  }, [finalizeCurrentPlay, status.volume])

  const skip = useCallback(async () => {
    if (IS_TAURI) await invoke('queue_skip')
    else startWebTrack(webQueueIndex.current + 1)
  }, [startWebTrack])

  const seek = useCallback(async (positionMs: number) => {
    if (IS_TAURI) {
      await invoke('queue_seek', { positionMs })
    } else if (audioRef.current) {
      // The transcode stream has no Range support (server/src/routes/files.ts
      // spawns ffmpeg fresh per request, no seek param) — this only actually
      // lands within whatever the browser has already buffered.
      audioRef.current.currentTime = positionMs / 1000
    }
    setStatus((s) => ({ ...s, positionMs }))
  }, [])

  const setVolume = useCallback(async (value: number) => {
    const clamped = Math.min(1, Math.max(0, value))
    if (IS_TAURI) await invoke('queue_set_volume', { value: clamped })
    else if (audioRef.current) audioRef.current.volume = clamped
    setStatus((s) => ({ ...s, volume: clamped }))
  }, [])

  // null means "system default" — tearing the session down here (mirrored
  // on the Rust side) is deliberate: rodio can't swap a Sink's output
  // stream live, so the new device only takes effect on the next play.
  // No web-mode equivalent — device enumeration is native-only (see
  // LegatoSettings.tsx, which doesn't offer this control outside Tauri).
  const setAudioDevice = useCallback(async (name: string | null) => {
    if (!IS_TAURI) return
    await invoke('queue_set_device', { name })
  }, [])

  return { status, currentTitle, upNext, playNode, pause, resume, stop, skip, seek, setVolume, setAudioDevice }
}
