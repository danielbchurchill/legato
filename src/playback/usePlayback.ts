import { useCallback, useEffect, useState } from 'react'
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

async function resolveTracks(recordingNodeIds: number[]): Promise<ResolvedTrack[]> {
  const res = await fetch(`${API}/queue/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recordingNodeIds }),
  })
  const data = await res.json()
  return (data.tracks as (ResolvedTrack | null)[]).filter((t): t is ResolvedTrack => t != null)
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

  useEffect(() => {
    const unlistenPosition = listen<{ position_ms: number; recording_node_id: number | null }>(
      'playback://position',
      (e) => {
        setStatus((s) => ({ ...s, positionMs: e.payload.position_ms, currentRecordingNodeId: e.payload.recording_node_id }))
      },
    ).catch(() => undefined)

    const unlistenTrackChanged = listen<{ recording_node_id: number | null }>('playback://track-changed', (e) => {
      const nodeId = e.payload.recording_node_id
      setStatus((s) => ({ ...s, currentRecordingNodeId: nodeId }))
      if (nodeId != null) {
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
  }, [])

  const playNode = useCallback(async (recordingNodeId: number, title: string) => {
    const tracks = await resolveTracks([recordingNodeId])
    if (tracks.length === 0) return
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
  }, [])

  const pause = useCallback(async () => {
    await invoke('queue_pause')
    setStatus((s) => ({ ...s, playing: false }))
  }, [])

  const resume = useCallback(async () => {
    await invoke('queue_play')
    setStatus((s) => ({ ...s, playing: true }))
  }, [])

  const stop = useCallback(async () => {
    await invoke('queue_stop')
    setStatus({ playing: false, positionMs: 0, currentRecordingNodeId: null })
    setCurrentTitle(null)
  }, [])

  const skip = useCallback(async () => {
    await invoke('queue_skip')
  }, [])

  return { status, currentTitle, playNode, pause, resume, stop, skip }
}
