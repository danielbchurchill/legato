import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { API_BASE as API } from '../config/serverHost'
import { IS_TAURI } from '../config/runtime'
import { streamUrl, watchForDrops } from './quality'
import { useMediaSession } from './mediaSession'
import { notePlaybackStarted } from '../pwa/installOffer'
import {
  describePlaybackError,
  isNativePlaybackError,
  readLibraryRoots,
  type LibraryRootReachability,
  type PlaybackProblem,
} from './playbackError'

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

/* Where the current queue came from, for the now-playing panel's "Playing
 * from …" line. Set by the entry points that know (an album, a playlist,
 * the shuffled library); a bare playTracks with no source says nothing
 * rather than guessing. */
export type QueueSource = { kind: 'release'; nodeId: number } | { kind: 'playlist'; playlistId: number } | { kind: 'library' }
export type ReplayGainMode = 'track' | 'album' | 'off'
// Issue #125: off -> all -> one, a persisted
// player setting (App.tsx reads/writes it via useSettings, same as
// replaygainMode) rather than per-queue state — unlike shuffle, which lives
// entirely in playSequence/originalOrder below.
export type RepeatMode = 'off' | 'all' | 'one'

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
async function resolveQueueContext(
  recordingNodeId: number,
  fallbackTitle: string,
): Promise<{ entries: QueueEntry[]; releaseId: number | null }> {
  try {
    const node = (await fetch(`${API}/nodes/${recordingNodeId}`).then((r) => r.json())) as NodeDetail
    const releaseEdge = node.edges.find((e) => e.direction === 'out' && e.type === 'appears_on')
    if (!releaseEdge) return { entries: [{ recordingNodeId, title: node.title, durationMs: null }], releaseId: null }

    const tracklist = (await fetch(`${API}/nodes/${releaseEdge.other_id}/tracklist`).then((r) =>
      r.json(),
    )) as TracklistEntry[]
    const startIndex = tracklist.findIndex((t) => t.id === recordingNodeId)
    if (startIndex === -1) return { entries: [{ recordingNodeId, title: node.title, durationMs: null }], releaseId: releaseEdge.other_id }

    return {
      entries: tracklist.slice(startIndex).map((t) => ({ recordingNodeId: t.id, title: t.title, durationMs: t.canonical_duration_ms })),
      releaseId: releaseEdge.other_id,
    }
  } catch {
    // Context resolution is an enhancement, not a requirement — a network
    // hiccup here shouldn't block playing the one track the user clicked.
    return { entries: [{ recordingNodeId, title: fallbackTitle, durationMs: null }], releaseId: null }
  }
}

// Fetched at failure time rather than cached: what matters is whether the
// server can see each root *now*, and a failed play is rare enough that one
// extra request costs nothing. Any failure here just means the message
// works from the local evidence alone (see playbackError.ts).
async function fetchLibraryRoots(): Promise<LibraryRootReachability[]> {
  try {
    return readLibraryRoots(await fetch(`${API}/health`).then((r) => r.json()))
  } catch {
    return []
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
// route was built for (see AGENTS.md's Development Conventions). Both paths
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
export function usePlayback(replaygainMode: ReplayGainMode = 'track', repeatMode: RepeatMode = 'off') {
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
  const [queueSource, setQueueSource] = useState<QueueSource | null>(null)
  const [shuffled, setShuffled] = useState(false)
  // Issue #184: why the last start attempt didn't play, for the transport
  // to show. failedStart mirrors it for the imperative callbacks below,
  // the same way statusRef mirrors status. Non-null means Rust holds no
  // session and currentIndex points at the entry that couldn't open.
  const [problem, setProblem] = useState<PlaybackProblem | null>(null)
  const failedStart = useRef<PlaybackProblem | null>(null)

  // Mirrors `status` for code that needs the latest position/playing state
  // synchronously (the Tauri rebuild helpers below) without taking a
  // dependency on `status` itself — that would recreate every callback
  // derived from it on every 250ms position tick.
  const statusRef = useRef(status)
  useEffect(() => {
    statusRef.current = status
  }, [status])

  // Mirrors the `repeatMode` argument the same way statusRef mirrors
  // `status` — read by the imperative Tauri/web callbacks below without
  // making every one of them a new function identity on every mode change.
  const repeatModeRef = useRef(repeatMode)
  useEffect(() => {
    repeatModeRef.current = repeatMode
  }, [repeatMode])

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

  // Serializes every queue-mutating operation (playTracks/next/previous/
  // toggleShuffle/reorderQueue/removeFromQueue/addToQueue/playNext/pause/
  // resume) so a click fired while a previous one is still in flight runs
  // strictly after it instead of interleaving with it. Each of those reads
  // currentIndex.current/playSequence.current, then runs a chain of sequential `await
  // invoke(...)` Tauri calls (queue_stop, a loop of queue_enqueue,
  // queue_play) before writing its own update back to those refs — without
  // this, a second call's queue_stop can land mid-rebuild of the first
  // call's sequence (Rust's ensure_session spins up a fresh, empty session
  // on the next queue_enqueue after a queue_stop), producing a queue built
  // from an interleaved mix of both calls' tracks, or a queue_skip that
  // silently no-ops against a torn-down session. Both reproduce exactly:
  // "needs two or three clicks before anything visibly happens" and
  // "rapid clicking skips more tracks than intended."
  //
  // Queued rather than dropped — a second legitimate click (skip twice in
  // a row) should still happen, just strictly after the first completes,
  // not get silently swallowed.
  const operationChain = useRef<Promise<void>>(Promise.resolve())
  const pendingOperations = useRef(0)
  const [queueBusy, setQueueBusy] = useState(false)

  const serialized = useCallback(<T,>(fn: () => Promise<T>): Promise<T> => {
    pendingOperations.current += 1
    if (pendingOperations.current === 1) setQueueBusy(true)

    const run = operationChain.current.then(fn, fn)
    // Normalized to always resolve, even when `fn` throws — one failed
    // operation must not wedge every operation queued behind it.
    operationChain.current = run.then(
      () => undefined,
      () => undefined,
    )
    run.finally(() => {
      pendingOperations.current -= 1
      if (pendingOperations.current === 0) setQueueBusy(false)
    })
    return run
  }, [])

  // Web-fallback-only: the single <audio> element standing in for Rust's
  // queue. Lazy singleton construction during render (not an effect) is the
  // standard pattern for a one-time DOM object a ref should own for the
  // component's whole lifetime — see React's docs on creating objects
  // lazily.
  const audioRef = useRef<HTMLAudioElement | null>(null)
  if (!IS_TAURI && audioRef.current === null) audioRef.current = new Audio()

  // #119: one player owns the sound. The shell stays mounted through an
  // outage, but whatever does unmount it (signing out, say) takes its audio
  // with it, rather than leaving an element still playing that nothing on
  // screen can pause.
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    return () => {
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
    }
  }, [])

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
      audio.src = streamUrl(info.fileId)
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

  // #125's off/all/one for the web-fallback path — Rust's reconcile_repeat
  // (playback.rs) has no equivalent here since there's no Sink to
  // re-append to, so the <audio> element just gets told which index to
  // load next. Shared by onEnded (automatic) and the manual next() below
  // so both honor the same wraparound.
  const advanceWebTrack = useCallback(
    (fromIndex: number) => {
      if (repeatModeRef.current === 'one') {
        startWebTrack(fromIndex)
        return
      }
      const nextIndex = fromIndex + 1
      if (repeatModeRef.current === 'all' && !playSequence.current[nextIndex]) {
        startWebTrack(0)
        return
      }
      startWebTrack(nextIndex)
    },
    [startWebTrack],
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
    const currentDurationMs = () => {
      const entry = playSequence.current[currentIndex.current]
      return entry ? (trackInfo.current.get(entry.recordingNodeId)?.durationMs ?? null) : null
    }

    audio.addEventListener('timeupdate', onTimeUpdate)
    // #128: the install offer waits for sound actually coming out, which a
    // click on play alone doesn't prove (play() can still reject).
    audio.addEventListener('playing', notePlaybackStarted)
    // #120: a mid-track drop pauses this track and moves the next one down
    // the quality ladder (playback/quality.ts). #119: the end of a track
    // comes through there too, since a stream the server cut can end early,
    // and that's a drop, not the next track.
    const stopWatchingDrops = watchForDrops(audio, () => setStatus((s) => ({ ...s, playing: false })), {
      onEnded: () => advanceWebTrack(currentIndex.current),
      durationMs: currentDurationMs,
    })
    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate)
      audio.removeEventListener('playing', notePlaybackStarted)
      stopWatchingDrops()
    }
  }, [advanceWebTrack])

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

  // Hands playSequence[startIndex..] (or the slice of it a caller chose) to
  // Rust in order. The first entry is the track about to play: if it can't
  // open, nothing started, so enqueuing stops there and its error comes
  // back for showStartFailure. A later entry that can't open is dropped
  // from playSequence instead (one missing file shouldn't stop the rest of
  // an album) so up-next keeps showing only what will really play.
  const enqueueTauri = useCallback(
    async (entries: QueueEntry[], startIndex: number): Promise<{ error: unknown } | null> => {
      const unplayable = new Set<number>()
      for (const [i, entry] of entries.entries()) {
        const info = trackInfo.current.get(entry.recordingNodeId)!
        try {
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
        } catch (error) {
          if (i === 0) return { error }
          unplayable.add(entry.recordingNodeId)
        }
      }
      if (unplayable.size > 0) {
        playSequence.current = [
          ...playSequence.current.slice(0, startIndex + 1),
          ...playSequence.current.slice(startIndex + 1).filter((e) => !unplayable.has(e.recordingNodeId)),
        ]
      }
      return null
    },
    [replaygainMode],
  )

  // A track that never started. The dock stays mounted (it keys off
  // currentTitle) so the reason has somewhere to show, while
  // currentRecordingNodeId stays null so nothing else, the canvas halo or
  // the now-playing panel, claims the track is live.
  const showStartFailure = useCallback(
    async (index: number, error: unknown) => {
      // playback.rs already drops a session whose first track failed; this
      // covers any other rejection, so nothing stale is left half-built.
      await invoke('queue_stop').catch(() => undefined)
      finalizeCurrentPlay()
      const title = playSequence.current[index]?.title ?? ''
      currentIndex.current = index
      setCurrentTitle(title)
      setUpNext(playSequence.current.slice(index + 1))
      setStatus((s) => ({
        ...s,
        playing: false,
        positionMs: 0,
        currentRecordingNodeId: null,
        currentFileId: null,
        currentDurationMs: null,
      }))
      // Only an unreachable file needs the server's view of the drive; the
      // other two kinds say everything on their own.
      const roots = isNativePlaybackError(error) && error.kind === 'file_unreachable' ? await fetchLibraryRoots() : []
      const described = describePlaybackError(error, title, roots)
      failedStart.current = described
      setProblem(described)
    },
    [finalizeCurrentPlay],
  )

  const clearStartFailure = useCallback(() => {
    failedStart.current = null
    setProblem(null)
  }, [])

  // The generalized entry point everything else funnels through: given an
  // explicit ordered list of recording node ids and where to start in it,
  // resolve, populate playSequence/currentIndex, and start playback. Only
  // playSequence[startIndex..] is ever handed to the Rust engine — the
  // engine's own queue is forward-only, so anything before the start point
  // exists solely in this hook's bookkeeping (for previous() to walk back
  // into).
  //
  // #81 persisted past PR #94: that PR put pause/resume behind `serialized`
  // but never touched this function, which runs the exact same
  // queue_stop -> queue_enqueue... -> queue_play shape every other
  // serialized operation does. Every "click a track/album to play it"
  // button in the app (PlayNodeButton, NodeCard's canvas card, the
  // MetadataActions play icon, NowPlayingPanel's quick-play, Playlists) goes
  // through playNode/playAlbum/playRandom/playPlaylist and lands here, so
  // clicking play while a next()/previous()/pause() rebuild was mid-flight —
  // or just double-clicking a play button — could interleave two invoke()
  // chains exactly like the original bug, just for the entry point that
  // starts a fresh queue instead of mutating an existing one. Split into an
  // unserialized core (below) plus this serialized wrapper so addToQueue/
  // playNext can call the core directly from inside their own `serialized`
  // block without deadlocking (re-entering `serialized` while already
  // running inside it would wait on a promise chain that can't resolve
  // until the very call doing the waiting returns).
  const playTracksCore = useCallback(
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

      // Repeat-one only ever hands Rust the one track it's going to loop —
      // see rebuildTauriQueueInPlace's comment below for why the rest of
      // the tail has to wait rather than being pre-enqueued as usual.
      const toPlay =
        repeatModeRef.current === 'one'
          ? sequence.slice(resolvedStartIndex, resolvedStartIndex + 1)
          : sequence.slice(resolvedStartIndex)

      if (!IS_TAURI) {
        startWebTrack(resolvedStartIndex)
        return
      }

      finalizeCurrentPlay()
      await invoke('queue_stop')
      const failure = await enqueueTauri(toPlay, resolvedStartIndex)
      if (failure) {
        await showStartFailure(resolvedStartIndex, failure.error)
        return
      }
      await invoke('queue_play')
      clearStartFailure()
      const startEntry = toPlay[0]
      const startInfo = trackInfo.current.get(startEntry.recordingNodeId)!
      setCurrentTitle(startEntry.title || title)
      setUpNext(playSequence.current.slice(resolvedStartIndex + 1))
      setStatus((s) => ({
        ...s,
        playing: true,
        currentRecordingNodeId: startEntry.recordingNodeId,
        currentFileId: startInfo.fileId,
        currentDurationMs: startInfo.durationMs,
      }))
    },
    [cacheTracks, clearStartFailure, enqueueTauri, finalizeCurrentPlay, showStartFailure, startWebTrack],
  )

  const playTracks = useCallback(
    (recordingNodeIds: number[], startIndex: number, title: string, source: QueueSource | null = null) => {
      setQueueSource(source)
      return serialized(() => playTracksCore(recordingNodeIds, startIndex, title))
    },
    [playTracksCore, serialized],
  )

  const playNode = useCallback(
    async (recordingNodeId: number, title: string) => {
      const { entries, releaseId } = await resolveQueueContext(recordingNodeId, title)
      for (const entry of entries) titleCache.current.set(entry.recordingNodeId, entry.title)
      const startIndex = entries.findIndex((c) => c.recordingNodeId === recordingNodeId)
      await playTracks(
        entries.map((c) => c.recordingNodeId),
        startIndex === -1 ? 0 : startIndex,
        title,
        releaseId != null ? { kind: 'release', nodeId: releaseId } : null,
      )
    },
    [playTracks],
  )

  // #57's collapsed-empty-panel "quick play" button: no dedicated
  // random-track endpoint exists server-side, so this just reuses GET
  // /nodes (the same call Canvas.tsx's useGraphData makes to populate the
  // graph — "the currently loaded library") and picks one recording node
  // client-side. playNode does the actual queueing, same as every other
  // entry point above.
  const playRandom = useCallback(async () => {
    try {
      const nodes = (await fetch(`${API}/nodes`).then((r) => r.json())) as { id: number; type: string; title: string }[]
      const recordings = nodes.filter((n) => n.type === 'recording')
      if (recordings.length === 0) return
      const pick = recordings[Math.floor(Math.random() * recordings.length)]
      await playNode(pick.id, pick.title)
    } catch {
      // Same policy as playAlbum/playPlaylist's own catch — a resolution
      // hiccup here just means playback doesn't start.
    }
  }, [playNode])

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
          { kind: 'release', nodeId: releaseId },
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
    // Repeat-one deliberately enqueues only the current track into Rust,
    // never the rest of the tail behind it — rodio's Sink plays whatever's
    // appended strictly in append order, so anything queued behind the
    // looping track would play *after* it finishes once instead of the
    // track looping. Rust's own reconcile_repeat (playback.rs) re-appends
    // that same lone track on every natural completion to keep the loop
    // gapless; the rest of playSequence stays valid app-side (up-next still
    // shows it) and gets sent for real the moment repeat leaves 'one'.
    const toEnqueue =
      repeatModeRef.current === 'one'
        ? playSequence.current.slice(currentIndex.current, currentIndex.current + 1)
        : playSequence.current.slice(currentIndex.current)
    if (toEnqueue.length === 0) return

    // After a failed start Rust holds nothing to rebuild; the edit only
    // changes what play (or the transport's retry/skip) will start next.
    if (failedStart.current) {
      setUpNext(playSequence.current.slice(currentIndex.current + 1))
      return
    }

    const wasPlaying = statusRef.current.playing
    const resumeAtMs = statusRef.current.positionMs

    await invoke('queue_stop')
    const failure = await enqueueTauri(toEnqueue, currentIndex.current)
    if (failure) {
      await showStartFailure(currentIndex.current, failure.error)
      return
    }
    await invoke('queue_play')
    await invoke('queue_seek', { positionMs: resumeAtMs })
    // A reorder/shuffle/remove/insert shouldn't itself resume a paused
    // track — the rebuild above needs queue_play to load the source before
    // queue_seek can land, so re-pause immediately after.
    if (!wasPlaying) await invoke('queue_pause')

    setUpNext(playSequence.current.slice(currentIndex.current + 1))
  }, [ensureResolved, enqueueTauri, showStartFailure])

  // Pushes a repeat-mode change straight to Rust (queue_set_repeat, used by
  // its own natural-completion gapless looping) and rebuilds the live
  // session to match the new mode's enqueue policy — entering 'one' has to
  // shrink what's enqueued down to just the current track, leaving it has
  // to restore the rest of the tail. See rebuildTauriQueueInPlace's own
  // comment above for why the enqueued set has to change at all. The
  // rebuild no-ops when nothing's playing (currentIndex is -1) — there's
  // nothing to rebuild yet, and the next playTracksCore call already reads
  // repeatModeRef fresh.
  //
  // #186: queue_set_repeat runs inside the lock too, so a repeat change
  // made while a skip or play is mid-rebuild lands after that rebuild's
  // queue_play, never between its queue_stop and queue_play. currentIndex
  // is read in there as well, for the same stale-ref reason as every other
  // serialized operation.
  useEffect(() => {
    if (!IS_TAURI) return
    void serialized(async () => {
      await invoke('queue_set_repeat', { mode: repeatMode }).catch(() => undefined)
      if (currentIndex.current === -1) return
      await rebuildTauriQueueInPlace()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repeatMode])

  const toggleShuffle = useCallback(
    () =>
      serialized(async () => {
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
      }),
    [shuffled, rebuildTauriQueueInPlace, serialized],
  )

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
          { kind: 'playlist', playlistId },
        )
        if (shuffled) await toggleShuffle()
      } catch {
        // Same policy as playAlbum.
      }
    },
    [playTracks, toggleShuffle],
  )

  // Shuffle library (#307). The tracks come from the map's graph, already
  // shuffled, and nothing on the way to POST /queue/resolve carries their
  // titles, so they're cached here as playAlbum caches its tracklist's.
  // Without them the player's title line was blank and up next showed
  // artists only.
  const playLibrary = useCallback(
    async (tracks: { id: number; title: string }[]) => {
      if (tracks.length === 0) return
      for (const t of tracks) titleCache.current.set(t.id, t.title)
      await playTracks(
        tracks.map((t) => t.id),
        0,
        tracks[0].title,
        { kind: 'library' },
      )
    },
    [playTracks],
  )

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
    clearStartFailure()
  }, [clearStartFailure, finalizeCurrentPlay, status.volume])

  // Full stop/re-enqueue/play rebuild onto playSequence[targetIndex] — the
  // native counterpart to startWebTrack above. Shared by previous() (which
  // always needs a real rebuild; queue_skip only moves forward) and by
  // next() specifically under repeat-one, where Rust holds nothing behind
  // the single looping track to skip to (see queue_skip's own doc comment
  // in playback.rs). Truncates to just the target track under repeat-one,
  // same as playTracksCore/rebuildTauriQueueInPlace, so the Sink never
  // gets handed a track it would have to reorder away from later.
  const jumpToIndexTauri = useCallback(
    async (targetIndex: number) => {
      const entries =
        repeatModeRef.current === 'one'
          ? playSequence.current.slice(targetIndex, targetIndex + 1)
          : playSequence.current.slice(targetIndex)
      await ensureResolved(entries)
      const resolved = entries.filter((e) => trackInfo.current.has(e.recordingNodeId))
      if (resolved.length === 0) return false

      finalizeCurrentPlay()
      await invoke('queue_stop')
      const failure = await enqueueTauri(resolved, targetIndex)
      if (failure) {
        // Handled, not a reason for next()'s repeat-one branch to stop():
        // the transport now says why, and offers retry or skip.
        await showStartFailure(targetIndex, failure.error)
        return true
      }
      await invoke('queue_play')
      clearStartFailure()

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
      return true
    },
    [clearStartFailure, enqueueTauri, ensureResolved, finalizeCurrentPlay, showStartFailure],
  )

  const next = useCallback(
    () =>
      serialized(async () => {
        if (!IS_TAURI) {
          advanceWebTrack(currentIndex.current)
          return
        }
        // Rust holds nothing to skip after a failed start, so walk
        // playSequence instead. Past the end, nothing is left to try.
        if (failedStart.current) {
          if (playSequence.current[currentIndex.current + 1]) await jumpToIndexTauri(currentIndex.current + 1)
          else await stop()
          return
        }
        // repeat-one: Rust's Sink only ever holds the one looping track
        // (reconcile_repeat in playback.rs), so queue_skip has nothing
        // real behind it to advance to — rebuild onto the same index
        // instead, which just restarts the current track.
        if (repeatModeRef.current === 'one') {
          const ok = await jumpToIndexTauri(currentIndex.current)
          if (!ok) await stop()
          return
        }
        await invoke('queue_skip')
      }),
    [serialized, advanceWebTrack, jumpToIndexTauri, stop],
  )

  const previous = useCallback(
    () =>
      serialized(async () => {
        if (currentIndex.current <= 0) return
        const targetIndex = currentIndex.current - 1

        if (!IS_TAURI) {
          startWebTrack(targetIndex)
          return
        }

        await jumpToIndexTauri(targetIndex)
      }),
    [jumpToIndexTauri, startWebTrack, serialized],
  )

  // #81: pause/resume used to run outside `serialized`, the one queue-
  // mutating operation that did — a click here could fire its single
  // queue_pause/queue_play invoke() in the middle of another operation's
  // queue_stop -> queue_enqueue... -> queue_play rebuild sequence (previous/
  // toggleShuffle/reorderQueue/etc.), landing before that rebuild's own
  // trailing queue_play (or queue_pause, when the rebuild has to restore a
  // paused state) and getting silently overwritten by it. That reproduces
  // exactly as "play/pause needs several clicks before anything happens" —
  // same race class `serialized`'s own module comment above already
  // documents, just for the one call it hadn't been applied to.
  const pause = useCallback(
    () =>
      serialized(async () => {
        if (IS_TAURI) await invoke('queue_pause')
        else audioRef.current?.pause()
        setStatus((s) => ({ ...s, playing: false }))
      }),
    [serialized],
  )

  const resume = useCallback(
    () =>
      serialized(async () => {
        if (IS_TAURI) {
          // After a failed start there's no session for queue_play to
          // resume, so play means try that track again (the drive may be
          // back by now).
          if (failedStart.current) {
            await jumpToIndexTauri(currentIndex.current)
            return
          }
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
      }),
    [jumpToIndexTauri, serialized],
  )

  // The transport's one action for a failed start (PlaybackProblem.action):
  // retry the same entry, or skip past it. Same paths as play and next.
  const resolveProblem = useCallback(() => {
    if (failedStart.current?.action === 'skip') return next()
    return resume()
  }, [next, resume])

  // Both queue edits take an index into the whole play sequence, which only
  // this hook knows the current position in. The *Core forms do the edit
  // with no lock; the exported forms run them inside `serialized`, either
  // with absolute indices (reorderQueue/removeFromQueue) or with indices
  // into upNext, resolved against currentIndex only once the lock is held
  // (moveUpNext/removeUpNext) — so a track advancing between a click and
  // its turn in the queue can't shift which row the edit lands on.
  const reorderQueueCore = useCallback(
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

  const removeFromQueueCore = useCallback(
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

  const reorderQueue = useCallback(
    (fromIndex: number, toIndex: number) => serialized(() => reorderQueueCore(fromIndex, toIndex)),
    [reorderQueueCore, serialized],
  )

  const removeFromQueue = useCallback((index: number) => serialized(() => removeFromQueueCore(index)), [removeFromQueueCore, serialized])

  const moveUpNext = useCallback(
    (from: number, to: number) =>
      serialized(() => reorderQueueCore(currentIndex.current + 1 + from, currentIndex.current + 1 + to)),
    [reorderQueueCore, serialized],
  )

  const removeUpNext = useCallback(
    (index: number) => serialized(() => removeFromQueueCore(currentIndex.current + 1 + index)),
    [removeFromQueueCore, serialized],
  )

  // Drops everything after the current track; the current one keeps playing.
  const clearUpNext = useCallback(
    () =>
      serialized(async () => {
        if (currentIndex.current < 0) return
        if (playSequence.current.length <= currentIndex.current + 1) return
        playSequence.current = playSequence.current.slice(0, currentIndex.current + 1)
        if (!IS_TAURI) {
          setUpNext([])
          return
        }
        await rebuildTauriQueueInPlace()
      }),
    [rebuildTauriQueueInPlace, serialized],
  )

  const addToQueue = useCallback(
    (recordingNodeId: number) =>
      serialized(async () => {
        if (currentIndex.current === -1) {
          // playTracksCore, not playTracks — this callback already runs
          // inside `serialized`, and playTracks re-entering that same lock
          // would wait on a promise chain that can't resolve until this
          // very call returns.
          await playTracksCore([recordingNodeId], 0, await fetchNodeTitle(recordingNodeId))
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
      }),
    [playTracksCore, rebuildTauriQueueInPlace, cacheTracks, serialized],
  )

  const playNext = useCallback(
    (recordingNodeId: number) =>
      serialized(async () => {
        if (currentIndex.current === -1) {
          // See addToQueue's comment above — playTracksCore, not playTracks.
          await playTracksCore([recordingNodeId], 0, await fetchNodeTitle(recordingNodeId))
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
      }),
    [playTracksCore, rebuildTauriQueueInPlace, cacheTracks, serialized],
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

  // #128: lock-screen and headphone controls for the browser player. Off
  // in Tauri, where native media keys are #131's.
  useMediaSession({
    enabled: !IS_TAURI,
    status,
    title: currentTitle,
    controls: { play: resume, pause, next, previous, seek },
  })

  return {
    status,
    currentTitle,
    upNext,
    queueSource,
    shuffled,
    // True whenever a playTracks/next/previous/toggleShuffle/reorderQueue/
    // removeFromQueue/addToQueue/playNext/pause/resume call is running or
    // queued behind one that is — see the `serialized` lock above. Drive
    // button-disabled states off this rather than tracking per-call pending
    // state locally, since any of these operations blocks all the others.
    // playNode/playAlbum/playRandom/playPlaylist/playLibrary all fire this through
    // playTracks (or, for playPlaylist's optional shuffle, a follow-up
    // toggleShuffle call), so it covers every "play this" button too, not
    // just the transport controls.
    queueBusy,
    // Why the last start attempt didn't play (#184), or null. While set,
    // nothing is playing, and resolveProblem runs its one suggested action.
    problem,
    resolveProblem,
    playNode,
    playTracks,
    playAlbum,
    playPlaylist,
    playLibrary,
    playRandom,
    addToQueue,
    playNext,
    reorderQueue,
    removeFromQueue,
    moveUpNext,
    removeUpNext,
    clearUpNext,
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
