// @vitest-environment jsdom
//
// Regression coverage for the queue-operation race described in
// usePlayback.ts's `serialized` lock: next/previous/toggleShuffle/
// reorderQueue/removeFromQueue/addToQueue/playNext each read
// currentIndex.current/playSequence.current, run a chain of sequential
// `await invoke(...)` Tauri calls, and only then write their own update
// back to those refs. Without serialization, a second call fired before
// the first one's chain finishes reads the same stale refs and its Tauri
// invoke sequence can land interleaved with the first call's — producing
// either a queue built from a mix of both calls' tracks, or a later call
// silently no-op'ing against state the first call hasn't written yet.
//
// invoke() is mocked with a real (if small) delay specifically so two
// overlapping calls have every opportunity to actually interleave if
// nothing is serializing them — this is the "no clean harness" case
// CLAUDE.md's testing conventions call for skipping if it can't be made to
// work; it can be, and does not depend on tuning that delay to hit a
// timing window (see the ordering argument in each test's comment).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => true,
  invoke: invokeMock,
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => undefined)),
}))

import { usePlayback } from './usePlayback'

// A believable IPC round-trip delay — real enough that a second, unguarded
// invoke() call has time to fire before the first one's promise resolves,
// matching the actual Tauri IPC round-trip this stands in for.
const INVOKE_DELAY_MS = 5

type Track = {
  recordingNodeId: number
  fileId: number
  filePath: string
  format: string | null
  bitrate: number | null
  durationMs: number | null
  replaygainTrackGain: number | null
  replaygainAlbumGain: number | null
}

function makeTrack(id: number): Track {
  return {
    recordingNodeId: id,
    fileId: id * 10,
    filePath: `/music/${id}.flac`,
    format: 'flac',
    bitrate: null,
    durationMs: 200_000,
    replaygainTrackGain: null,
    replaygainAlbumGain: null,
  }
}

const TRACKS: Record<number, Track> = { 10: makeTrack(10), 20: makeTrack(20), 30: makeTrack(30), 40: makeTrack(40) }

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

beforeEach(() => {
  invokeMock.mockReset()
  invokeMock.mockImplementation((cmd: string) => {
    // Resolved on the mount effect's queue_status call — not part of any
    // call sequence under test, so it doesn't need the artificial delay.
    if (cmd === 'queue_status') return Promise.resolve({ volume: 1 })
    return delay(INVOKE_DELAY_MS)
  })

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/queue/resolve')) {
        const body = JSON.parse((init?.body as string) ?? '{}') as { recordingNodeIds: number[] }
        const tracks = body.recordingNodeIds.map((id) => TRACKS[id]).filter(Boolean)
        return { json: async () => ({ tracks }) } as Response
      }
      throw new Error(`usePlayback.race.spec: unexpected fetch ${url}`)
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function renderPlaybackHook() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root!: Root
  const result: { current: ReturnType<typeof usePlayback> | null } = { current: null }

  function Harness() {
    result.current = usePlayback('track')
    return null
  }

  act(() => {
    root = createRoot(container)
    root.render(createElement(Harness))
  })

  return { result, unmount: () => act(() => root.unmount()) }
}

// Reduces an invoke() call log to just what these tests care about —
// command name, and (for queue_enqueue) which recording node it enqueued —
// so the ordering assertions below aren't tangled up with file paths and
// ReplayGain values that are already covered by reading the source.
function summarizeCalls(calls: unknown[][]): { cmd: string; recordingNodeId?: number }[] {
  return calls.map(([cmd, args]) => {
    const track = (args as { track?: { recording_node_id: number } } | undefined)?.track
    return track ? { cmd: cmd as string, recordingNodeId: track.recording_node_id } : { cmd: cmd as string }
  })
}

describe('usePlayback Tauri queue-operation serialization', () => {
  it('runs a second previous() call strictly after the first completes, instead of interleaving their invoke sequences', async () => {
    const { result, unmount } = renderPlaybackHook()
    await act(async () => {
      await delay(0)
    })

    // Seed a 4-track queue starting on the last track (index 3) so
    // previous() has two full steps to walk back through.
    await act(async () => {
      await result.current!.playTracks([10, 20, 30, 40], 3, 'Track 40')
    })
    expect(result.current!.status.currentRecordingNodeId).toBe(40)

    invokeMock.mockClear()

    // Two rapid clicks — exactly what a real double-click on TransportDock's
    // "previous" button produces: the second call fires before the first
    // one's promise has resolved.
    let p1: Promise<void> = Promise.resolve()
    let p2: Promise<void> = Promise.resolve()
    act(() => {
      p1 = result.current!.previous()
      p2 = result.current!.previous()
    })
    await act(async () => {
      await Promise.all([p1, p2])
    })

    expect(summarizeCalls(invokeMock.mock.calls)).toEqual([
      // First previous(): index 3 -> 2 (track 30), re-enqueues [30, 40].
      { cmd: 'queue_stop' },
      { cmd: 'queue_enqueue', recordingNodeId: 30 },
      { cmd: 'queue_enqueue', recordingNodeId: 40 },
      { cmd: 'queue_play' },
      // Second previous(), queued behind the first rather than racing it:
      // index 2 -> 1 (track 20), re-enqueues [20, 30, 40]. Without the fix
      // this read currentIndex while it was still 3 (the first call hadn't
      // written 2 back yet), so both calls targeted index 2 and one whole
      // decrement was lost.
      { cmd: 'queue_stop' },
      { cmd: 'queue_enqueue', recordingNodeId: 20 },
      { cmd: 'queue_enqueue', recordingNodeId: 30 },
      { cmd: 'queue_enqueue', recordingNodeId: 40 },
      { cmd: 'queue_play' },
    ])
    // Two full previous() steps landed — not one, and not an interleaved
    // mix of both calls' target tracks.
    expect(result.current!.status.currentRecordingNodeId).toBe(20)

    unmount()
  })

  it('runs a queued reorderQueue() only after an in-flight previous() has updated currentIndex, rather than bouncing off a stale bounds check', async () => {
    const { result, unmount } = renderPlaybackHook()
    await act(async () => {
      await delay(0)
    })

    // Start on index 1 (track 20). reorderQueue(1, 2)'s own guard
    // (`fromIndex <= currentIndex.current`) is only satisfied — i.e. only
    // actually runs — once previous() has moved currentIndex down to 0.
    // Read against the pre-previous() value (1), it silently no-ops
    // (1 <= 1), which is exactly the "second click does nothing" symptom.
    await act(async () => {
      await result.current!.playTracks([10, 20, 30, 40], 1, 'Track 20')
    })
    expect(result.current!.status.currentRecordingNodeId).toBe(20)

    invokeMock.mockClear()

    let p1: Promise<void> = Promise.resolve()
    let p2: Promise<void> = Promise.resolve()
    act(() => {
      p1 = result.current!.previous()
      p2 = result.current!.reorderQueue(1, 2)
    })
    await act(async () => {
      await Promise.all([p1, p2])
    })

    const calls = summarizeCalls(invokeMock.mock.calls)

    // previous()'s full sequence (index 1 -> 0, re-enqueues all four
    // tracks) lands first, uninterrupted by the queued reorder.
    expect(calls.slice(0, 6)).toEqual([
      { cmd: 'queue_stop' },
      { cmd: 'queue_enqueue', recordingNodeId: 10 },
      { cmd: 'queue_enqueue', recordingNodeId: 20 },
      { cmd: 'queue_enqueue', recordingNodeId: 30 },
      { cmd: 'queue_enqueue', recordingNodeId: 40 },
      { cmd: 'queue_play' },
    ])

    // reorderQueue(1, 2) only actually ran — rather than silently no-op'ing
    // against the stale currentIndex it would have read without the lock —
    // if a second rebuild sequence follows, moving track 30 (index 1 once
    // previous() lands) ahead of track 20 (index 2).
    expect(calls[6]).toEqual({ cmd: 'queue_stop' })
    const secondRunEnqueues = calls.slice(7).filter((c) => c.cmd === 'queue_enqueue')
    expect(secondRunEnqueues.map((c) => c.recordingNodeId)).toEqual([10, 30, 20, 40])

    unmount()
  })
})
