import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

const API = 'http://127.0.0.1:8899/api/v1'

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

export type PlaybackStatus = {
  playing: boolean
  positionMs: number
  currentRecordingNodeId: number | null
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

// Desktop-only: talks to the Rust playback engine (src-tauri/src/playback.rs)
// via Tauri IPC, never the server directly for audio — decode + gapless
// scheduling + device output all live in Rust, per Legato's platform split.
// invoke()/listen() are no-ops outside an actual Tauri window (a plain
// browser tab has no IPC bridge), so every call here is defensively
// wrapped rather than assumed to succeed.
export function usePlayback() {
  const [status, setStatus] = useState<PlaybackStatus>({
    playing: false,
    positionMs: 0,
    currentRecordingNodeId: null,
  })
  const [currentTitle, setCurrentTitle] = useState<string | null>(null)

  // fileId/durationMs per recording node, populated by playNode's own
  // resolveTracks() call — the only place a recordingNodeId maps to the
  // fileId a play report needs. currentPlay tracks the listening span in
  // progress; both are refs, not state, since neither should trigger a
  // re-render on every 250ms position tick.
  const trackInfo = useRef(new Map<number, { fileId: number; durationMs: number | null }>())
  const currentPlay = useRef<PlayInProgress | null>(null)

  const finalizeCurrentPlay = useCallback(() => {
    if (currentPlay.current) reportPlay(currentPlay.current)
    currentPlay.current = null
  }, [])

  useEffect(() => {
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
      setStatus((s) => ({ ...s, currentRecordingNodeId: nodeId }))
      if (nodeId != null) {
        const info = trackInfo.current.get(nodeId)
        currentPlay.current = info
          ? { recordingNodeId: nodeId, fileId: info.fileId, startedAt: new Date().toISOString(), lastPositionMs: 0 }
          : null
        fetch(`${API}/nodes/${nodeId}`)
          .then((r) => r.json())
          .then((n) => setCurrentTitle(n.title))
      } else {
        setCurrentTitle(null)
        setStatus((s) => ({ ...s, playing: false }))
      }
    }).catch(() => undefined)

    return () => {
      unlistenPosition.then((f) => f?.())
      unlistenTrackChanged.then((f) => f?.())
    }
  }, [finalizeCurrentPlay])

  const playNode = useCallback(async (recordingNodeId: number, title: string) => {
    const tracks = await resolveTracks([recordingNodeId])
    if (tracks.length === 0) return
    for (const t of tracks) trackInfo.current.set(t.recordingNodeId, { fileId: t.fileId, durationMs: t.durationMs })
    finalizeCurrentPlay()
    await invoke('queue_stop')
    for (const t of tracks) {
      await invoke('queue_enqueue', {
        track: {
          file_path: t.filePath,
          recording_node_id: t.recordingNodeId,
          replaygain_track_gain: t.replaygainTrackGain,
        },
      })
    }
    await invoke('queue_play')
    setCurrentTitle(title)
    setStatus((s) => ({ ...s, playing: true, currentRecordingNodeId: recordingNodeId }))
  }, [finalizeCurrentPlay])

  const pause = useCallback(async () => {
    await invoke('queue_pause')
    setStatus((s) => ({ ...s, playing: false }))
  }, [])

  const resume = useCallback(async () => {
    await invoke('queue_play')
    setStatus((s) => ({ ...s, playing: true }))
  }, [])

  const stop = useCallback(async () => {
    finalizeCurrentPlay()
    await invoke('queue_stop')
    setStatus({ playing: false, positionMs: 0, currentRecordingNodeId: null })
    setCurrentTitle(null)
  }, [finalizeCurrentPlay])

  const skip = useCallback(async () => {
    await invoke('queue_skip')
  }, [])

  return { status, currentTitle, playNode, pause, resume, stop, skip }
}
