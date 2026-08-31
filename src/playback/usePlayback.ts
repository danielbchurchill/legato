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

// Fisher-Yates, in place — used for both toggleShuffle's own tail-shuffle
// and playPlaylist's shuffled-start id order.
function shuffleInPlace<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[items[i], items[j]] = [items[j], items[i]]
  }
  return items
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

// Everything queue_enqueue needs for one track, cached the first time a
// recordingNodeId resolves so later queue operations (previous, shuffle,
// reorder, remove, insert) can re-enqueue without re-resolving.
type CachedTrack = {
  fileId: number
  filePath: string
  durationMs: number | null
  replaygainTrackGain: number | null
  replaygainAlbumGain: number | null
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

async function fetchNodeTitle(recordingNodeId: number): Promise<string> {
  try {
    const node = (await fetch(`${API}/nodes/${recordingNodeId}`).then((r) => r.json())) as { title: string }
    return node.title ?? ''
  } catch {
    return ''
  }
}

type NodeDetail = { title: string; edges: { direction: 'in' | 'out'; type: string; other_id: number }[] }
type TracklistEntry = { id: number; title: string; track_no: number | null; canonical_duration_ms: number | null }
type PlaylistTrackEntry = { id: number; title: string }

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
// present the same play/pause/seek/next/previous/queue-management interface
// below so the rest of the app doesn't care which backend is live
// underneath.
//
// The Rust engine's queue (src-tauri/src/playback.rs) is a plain
// VecDeque — forward-only, append-only. It has no concept of "insert in the
// middle" or "remove an already-appended item," so every queue-management
// operation here (previous, shuffle, reorder, remove, insert) that touches
// anything already sitting in the sink follows the same shape on the Tauri
// path: stop the session, re-enqueue from the current track forward, play,
// and (when the current track itself didn't change) seek back to where it
// was. The web path never has this problem — the <audio> element only ever
// holds the one currently-playing source, so queue edits are a plain array
// splice.
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
  const [shuffled, setShuffled] = useState(false)

  // Mirrors `status` for code that needs the latest position/playing state
  // synchronously (the Tauri rebuild helpers below) without taking a
  // dependency on `status` itself — that would recreate every callback
  // derived from it on every 250ms position tick.
  const statusRef = useRef(status)
  useEffect(() => {
    statusRef.current = status
  }, [status])

  // fileId/filePath/durationMs/gain per recording node, populated the first
  // time a track resolves (playTracks, or any queue-mutating call that
  // meets a node it hasn't seen) — the cache that lets previous()/shuffle/
  // reorder/remove/insert re-enqueue without re-resolving. titleCache is
  // separate because POST /queue/resolve (which fills trackInfo) doesn't
  // return titles — only the tracklist/playlist-tracks endpoints do, so
  // whichever call resolved a track's context populates it there.
  //
  // playSequence is the single ordered queue model shared by both playback
  // paths — the full list (already-played prefix included), with
  // currentIndex marking which entry is live. previous()/next() walk it by
  // index; up-next is always playSequence.slice(currentIndex + 1).
  // originalOrder holds the pre-shuffle order of the tail so toggling
  // shuffle back off can restore it. None of these are state — nothing
  // here should trigger a re-render on its own; positionMs already re-
  // renders on a 250ms tick and the rest reads through the state setters
  // below when something actually needs to be shown.
  const trackInfo = useRef(new Map<number, CachedTrack>())
  const titleCache = useRef(new Map<number, string>())
  const playSequence = useRef<QueueEntry[]>([])
  const currentIndex = useRef(-1)
  const originalOrder = useRef<QueueEntry[]>([])
  const currentPlay = useRef<PlayInProgress | null>(null)

  // Web-fallback-only: the single <audio> element standing in for Rust's
  // queue. Lazy singleton construction during render (not an effect) is the
  // standard pattern for a one-time DOM object a ref should own for the
  // component's whole lifetime — see React's docs on creating objects
  // lazily.
  const audioRef = useRef<HTMLAudioElement | null>(null)
  if (!IS_TAURI && audioRef.current === null) audioRef.current = new Audio()

  const finalizeCurrentPlay = useCallback(() => {
    if (currentPlay.current) reportPlay(currentPlay.current)
    currentPlay.current = null
  }, [])

  const cacheTracks = useCallback((tracks: ResolvedTrack[]) => {
    for (const t of tracks) {
      trackInfo.current.set(t.recordingNodeId, {
        fileId: t.fileId,
        filePath: t.filePath,
        durationMs: t.durationMs,
        replaygainTrackGain: t.replaygainTrackGain,
        replaygainAlbumGain: t.replaygainAlbumGain,
      })
    }
  }, [])

  // Resolves and caches only whatever isn't already in trackInfo — the
  // common case once a queue's been playing a while is "everything's
  // already cached," so this is a no-op network-wise most of the time.
  const ensureResolved = useCallback(
    async (entries: QueueEntry[]) => {
      const missingIds = entries.filter((e) => !trackInfo.current.has(e.recordingNodeId)).map((e) => e.recordingNodeId)
      if (missingIds.length === 0) return
      cacheTracks(await resolveTracks(missingIds))
    },
    [cacheTracks],
  )

  // Advances the web-fallback player to playSequence[index] — walking off
  // the end mirrors the Tauri path's playback://track-changed(null) case,
  // clearing now-playing state instead of looping or erroring.
  const startWebTrack = useCallback(
    (index: number) => {
      const audio = audioRef.current
      if (!audio) return
      const entry = playSequence.current[index]
      if (!entry) {
        finalizeCurrentPlay()
        audio.pause()
        playSequence.current = []
        currentIndex.current = -1
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
      currentIndex.current = index
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
      setUpNext(playSequence.current.slice(index + 1))
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
    const onEnded = () => startWebTrack(currentIndex.current + 1)

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
      const nodeId = e.payload.recording_node_id
      // A rebuild (shuffle/reorder/remove/insert while something's
      // playing) tears the Rust session down and re-enqueues starting with
      // the still-current track, which spawns a fresh monitor thread that
      // re-announces that same track as "changed." Treat that as a no-op
      // rather than a real track change — otherwise every rebuild would
      // wrongly close out and restart the in-flight scrobble/play-tracking
      // for a track that never actually stopped.
      const sameTrack = nodeId != null && currentPlay.current?.recordingNodeId === nodeId

      if (!sameTrack) finalizeCurrentPlay()

      if (nodeId != null) {
        const info = trackInfo.current.get(nodeId)

        if (!sameTrack) {
          currentPlay.current = info
            ? { recordingNodeId: nodeId, fileId: info.fileId, startedAt: new Date().toISOString(), lastPositionMs: 0 }
            : null

          const idx = playSequence.current.findIndex((t) => t.recordingNodeId === nodeId)
          if (idx !== -1) currentIndex.current = idx

          fetch(`${API}/nodes/${nodeId}`)
            .then((r) => r.json())
            .then((n) => setCurrentTitle(n.title))
        }

        setStatus((s) => ({
          ...s,
          currentRecordingNodeId: nodeId,
          currentFileId: info?.fileId ?? null,
          currentDurationMs: info?.durationMs ?? null,
        }))
        setUpNext(playSequence.current.slice(currentIndex.current + 1))
      } else {
        playSequence.current = []
        currentIndex.current = -1
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

  // The generalized entry point everything else funnels through: given an
  // explicit ordered list of recording node ids and where to start in it,
  // resolve, populate playSequence/currentIndex, and start playback. Only
  // playSequence[startIndex..] is ever handed to the Rust engine — the
  // engine's own queue is forward-only, so anything before the start point
  // exists solely in this hook's bookkeeping (for previous() to walk back
  // into).
  const playTracks = useCallback(
    async (recordingNodeIds: number[], startIndex: number, title: string) => {
      const tracks = await resolveTracks(recordingNodeIds)
      if (tracks.length === 0) return
      cacheTracks(tracks)

      const resolvedIds = new Set(tracks.map((t) => t.recordingNodeId))
      const anchorId = recordingNodeIds[startIndex]
      // Ids that failed to resolve (file missing since last scan) are
      // dropped entirely — up-next should only ever show what will really
      // play, same policy resolveQueueContext's caller relied on before.
      const sequence: QueueEntry[] = recordingNodeIds
        .filter((id) => resolvedIds.has(id))
        .map((id) => ({
          recordingNodeId: id,
          title: titleCache.current.get(id) ?? (id === anchorId ? title : ''),
          durationMs: trackInfo.current.get(id)?.durationMs ?? null,
        }))
      if (sequence.length === 0) return

      const resolvedStartIndex = Math.max(0, sequence.findIndex((e) => e.recordingNodeId === anchorId))

      playSequence.current = sequence
      currentIndex.current = resolvedStartIndex
      originalOrder.current = []
      setShuffled(false)

      const toPlay = sequence.slice(resolvedStartIndex)

      if (!IS_TAURI) {
        startWebTrack(resolvedStartIndex)
        return
      }

      finalizeCurrentPlay()
      await invoke('queue_stop')
      for (const entry of toPlay) {
        const info = trackInfo.current.get(entry.recordingNodeId)!
        await invoke('queue_enqueue', {
          track: {
            file_path: info.filePath,
            recording_node_id: entry.recordingNodeId,
            // Rust just applies whatever dB value arrives here — the mode
            // selection (track/album/off) is entirely a frontend decision
            // about *which* precomputed gain to send, not something the
            // audio engine needs to know about.
            replaygain_track_gain: gainForMode(info, replaygainMode),
          },
        })
      }
      await invoke('queue_play')
      const startEntry = toPlay[0]
      const startInfo = trackInfo.current.get(startEntry.recordingNodeId)!
      setCurrentTitle(startEntry.title || title)
      setUpNext(sequence.slice(resolvedStartIndex + 1))
      setStatus((s) => ({
        ...s,
        playing: true,
        currentRecordingNodeId: startEntry.recordingNodeId,
        currentFileId: startInfo.fileId,
        currentDurationMs: startInfo.durationMs,
      }))
    },
    [cacheTracks, finalizeCurrentPlay, replaygainMode, startWebTrack],
  )

  const playNode = useCallback(
    async (recordingNodeId: number, title: string) => {
      const context = await resolveQueueContext(recordingNodeId, title)
      for (const entry of context) titleCache.current.set(entry.recordingNodeId, entry.title)
      const startIndex = context.findIndex((c) => c.recordingNodeId === recordingNodeId)
      await playTracks(context.map((c) => c.recordingNodeId), startIndex === -1 ? 0 : startIndex, title)
    },
    [playTracks],
  )

  const playAlbum = useCallback(
    async (releaseId: number) => {
      try {
        const tracklist = (await fetch(`${API}/nodes/${releaseId}/tracklist`).then((r) => r.json())) as TracklistEntry[]
        if (tracklist.length === 0) return
        for (const t of tracklist) titleCache.current.set(t.id, t.title)
        await playTracks(
          tracklist.map((t) => t.id),
          0,
          '',
        )
      } catch {
        // A resolution hiccup here just means playback doesn't start —
        // same policy as resolveQueueContext's own catch.
      }
    },
    [playTracks],
  )

  // rodio's Sink is append-only — it can neither reorder nor remove an
  // already-appended source, so any change to tracks queued ahead of the
  // current one (shuffle, reorder, remove, insert) requires tearing the
  // Tauri session down and re-enqueuing playSequence[currentIndex..] fresh,
  // then seeking back to roughly where the current track was. That means a
  // brief audible re-decode of the current track on every such edit — a
  // known, accepted trade-off, not something worth trying to eliminate.
  const rebuildTauriQueueInPlace = useCallback(async () => {
    if (currentIndex.current === -1) return

    const entries = playSequence.current.slice(currentIndex.current)
    await ensureResolved(entries)
    const resolvedIds = new Set(entries.filter((e) => trackInfo.current.has(e.recordingNodeId)).map((e) => e.recordingNodeId))
    playSequence.current = [
      ...playSequence.current.slice(0, currentIndex.current),
      ...entries.filter((e) => resolvedIds.has(e.recordingNodeId)),
    ]
    const toEnqueue = playSequence.current.slice(currentIndex.current)
    if (toEnqueue.length === 0) return

    const wasPlaying = statusRef.current.playing
    const resumeAtMs = statusRef.current.positionMs

    await invoke('queue_stop')
    for (const entry of toEnqueue) {
      const info = trackInfo.current.get(entry.recordingNodeId)!
      await invoke('queue_enqueue', {
        track: {
          file_path: info.filePath,
          recording_node_id: entry.recordingNodeId,
          replaygain_track_gain: gainForMode(info, replaygainMode),
        },
      })
    }
    await invoke('queue_play')
    await invoke('queue_seek', { positionMs: resumeAtMs })
    // A reorder/shuffle/remove/insert shouldn't itself resume a paused
    // track — the rebuild above needs queue_play to load the source before
    // queue_seek can land, so re-pause immediately after.
    if (!wasPlaying) await invoke('queue_pause')

    setUpNext(playSequence.current.slice(currentIndex.current + 1))
  }, [ensureResolved, replaygainMode])

  const toggleShuffle = useCallback(async () => {
    if (currentIndex.current === -1) return
    const tail = playSequence.current.slice(currentIndex.current + 1)

    let newTail: QueueEntry[]
    if (!shuffled) {
      originalOrder.current = tail.slice()
      newTail = shuffleInPlace(tail.slice())
    } else {
      // Restore true original order for whatever's still in the tail;
      // anything added while shuffled (not part of the captured order)
      // keeps its place at the end rather than being dropped.
      const tailIds = new Set(tail.map((e) => e.recordingNodeId))
      const restored = originalOrder.current.filter((e) => tailIds.has(e.recordingNodeId))
      const restoredIds = new Set(restored.map((e) => e.recordingNodeId))
      newTail = [...restored, ...tail.filter((e) => !restoredIds.has(e.recordingNodeId))]
      originalOrder.current = []
    }

    playSequence.current = [...playSequence.current.slice(0, currentIndex.current + 1), ...newTail]
    setShuffled(!shuffled)

    if (!IS_TAURI) {
      setUpNext(newTail)
      return
    }
    await rebuildTauriQueueInPlace()
  }, [shuffled, rebuildTauriQueueInPlace])

  const playPlaylist = useCallback(
    async (playlistId: number, shuffled?: boolean) => {
      try {
        const tracks = (await fetch(`${API}/playlists/${playlistId}/tracks`).then((r) => r.json())) as PlaylistTrackEntry[]
        if (tracks.length === 0) return
        for (const t of tracks) titleCache.current.set(t.id, t.title)
        await playTracks(
          tracks.map((t) => t.id),
          0,
          '',
        )
        if (shuffled) await toggleShuffle()
      } catch {
        // Same policy as playAlbum.
      }
    },
    [playTracks, toggleShuffle],
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
    playSequence.current = []
    currentIndex.current = -1
    originalOrder.current = []
    setShuffled(false)
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

  const next = useCallback(async () => {
    if (IS_TAURI) await invoke('queue_skip')
    else startWebTrack(currentIndex.current + 1)
  }, [startWebTrack])

  const previous = useCallback(async () => {
    if (currentIndex.current <= 0) return
    const targetIndex = currentIndex.current - 1

    if (!IS_TAURI) {
      startWebTrack(targetIndex)
      return
    }

    const entries = playSequence.current.slice(targetIndex)
    await ensureResolved(entries)
    const resolved = entries.filter((e) => trackInfo.current.has(e.recordingNodeId))
    if (resolved.length === 0) return

    finalizeCurrentPlay()
    await invoke('queue_stop')
    for (const entry of resolved) {
      const info = trackInfo.current.get(entry.recordingNodeId)!
      await invoke('queue_enqueue', {
        track: {
          file_path: info.filePath,
          recording_node_id: entry.recordingNodeId,
          replaygain_track_gain: gainForMode(info, replaygainMode),
        },
      })
    }
    await invoke('queue_play')

    currentIndex.current = targetIndex
    const startEntry = resolved[0]
    const startInfo = trackInfo.current.get(startEntry.recordingNodeId)!
    setCurrentTitle(startEntry.title)
    setUpNext(playSequence.current.slice(targetIndex + 1))
    setStatus((s) => ({
      ...s,
      playing: true,
      currentRecordingNodeId: startEntry.recordingNodeId,
      currentFileId: startInfo.fileId,
      currentDurationMs: startInfo.durationMs,
    }))
  }, [ensureResolved, finalizeCurrentPlay, replaygainMode, startWebTrack])

  const reorderQueue = useCallback(
    async (fromIndex: number, toIndex: number) => {
      if (fromIndex <= currentIndex.current || toIndex <= currentIndex.current) return
      if (fromIndex < 0 || fromIndex >= playSequence.current.length) return
      if (toIndex < 0 || toIndex >= playSequence.current.length) return
      if (fromIndex === toIndex) return

      const reordered = playSequence.current.slice()
      const [moved] = reordered.splice(fromIndex, 1)
      reordered.splice(toIndex, 0, moved)
      playSequence.current = reordered

      if (!IS_TAURI) {
        setUpNext(playSequence.current.slice(currentIndex.current + 1))
        return
      }
      await rebuildTauriQueueInPlace()
    },
    [rebuildTauriQueueInPlace],
  )

  const removeFromQueue = useCallback(
    async (index: number) => {
      if (index <= currentIndex.current) return
      if (index < 0 || index >= playSequence.current.length) return

      playSequence.current = playSequence.current.filter((_, i) => i !== index)

      if (!IS_TAURI) {
        setUpNext(playSequence.current.slice(currentIndex.current + 1))
        return
      }
      await rebuildTauriQueueInPlace()
    },
    [rebuildTauriQueueInPlace],
  )

  const addToQueue = useCallback(
    async (recordingNodeId: number) => {
      if (currentIndex.current === -1) {
        await playTracks([recordingNodeId], 0, await fetchNodeTitle(recordingNodeId))
        return
      }

      const tracks = await resolveTracks([recordingNodeId])
      if (tracks.length === 0) return
      cacheTracks(tracks)
      const title = titleCache.current.get(recordingNodeId) ?? (await fetchNodeTitle(recordingNodeId))
      titleCache.current.set(recordingNodeId, title)

      playSequence.current = [...playSequence.current, { recordingNodeId, title, durationMs: tracks[0].durationMs }]

      if (!IS_TAURI) {
        setUpNext(playSequence.current.slice(currentIndex.current + 1))
        return
      }
      await rebuildTauriQueueInPlace()
    },
    [playTracks, rebuildTauriQueueInPlace, cacheTracks],
  )

  const playNext = useCallback(
    async (recordingNodeId: number) => {
      if (currentIndex.current === -1) {
        await playTracks([recordingNodeId], 0, await fetchNodeTitle(recordingNodeId))
        return
      }

      const tracks = await resolveTracks([recordingNodeId])
      if (tracks.length === 0) return
      cacheTracks(tracks)
      const title = titleCache.current.get(recordingNodeId) ?? (await fetchNodeTitle(recordingNodeId))
      titleCache.current.set(recordingNodeId, title)

      const entry: QueueEntry = { recordingNodeId, title, durationMs: tracks[0].durationMs }
      playSequence.current = [
        ...playSequence.current.slice(0, currentIndex.current + 1),
        entry,
        ...playSequence.current.slice(currentIndex.current + 1),
      ]

      if (!IS_TAURI) {
        setUpNext(playSequence.current.slice(currentIndex.current + 1))
        return
      }
      await rebuildTauriQueueInPlace()
    },
    [playTracks, rebuildTauriQueueInPlace, cacheTracks],
  )

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

  return {
    status,
    currentTitle,
    upNext,
    shuffled,
    playNode,
    playTracks,
    playAlbum,
    playPlaylist,
    addToQueue,
    playNext,
    reorderQueue,
    removeFromQueue,
    toggleShuffle,
    next,
    previous,
    pause,
    resume,
    stop,
    seek,
    setVolume,
    setAudioDevice,
  }
}
