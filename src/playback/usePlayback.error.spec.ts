// @vitest-environment jsdom
//
// Issue #184: when native playback can't open a file, the transport has to
// say so rather than silently not playing. invoke() is mocked the same way
// usePlayback.race.spec.ts mocks it, except queue_enqueue rejects with the
// PlaybackError shape src-tauri/src/playback.rs serializes.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativePlaybackError } from './playbackError'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => true,
  invoke: invokeMock,
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => undefined)),
}))

import { usePlayback } from './usePlayback'

function makeTrack(id: number) {
  return {
    recordingNodeId: id,
    fileId: id * 10,
    filePath: `/mnt/music/Music/Album/${id}.flac`,
    format: 'flac',
    bitrate: null,
    durationMs: 200_000,
    replaygainTrackGain: null,
    replaygainAlbumGain: null,
  }
}

// What playback.rs reports for any file under an NFS mount point that
// never came up: the mount point exists, empty.
function unmounted(path: string): NativePlaybackError {
  return {
    kind: 'file_unreachable',
    path,
    nearest_folder: '/mnt/music',
    nearest_folder_empty: true,
    detail: 'No such file or directory (os error 2)',
  }
}

// File paths whose queue_enqueue should reject. Cleared per test.
let unreachablePaths = new Set<string>()
let healthRoots: { libraryRootId: number; path: string; reachable: boolean | null }[] = []

beforeEach(() => {
  unreachablePaths = new Set()
  healthRoots = [{ libraryRootId: 1, path: '/mnt/music', reachable: true }]
  invokeMock.mockReset()
  invokeMock.mockImplementation(async (cmd: string, args?: { track?: { file_path: string } }) => {
    if (cmd === 'queue_status') return { volume: 1 }
    const path = args?.track?.file_path
    if (cmd === 'queue_enqueue' && path && unreachablePaths.has(path)) throw unmounted(path)
    return undefined
  })

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/queue/resolve')) {
        const body = JSON.parse((init?.body as string) ?? '{}') as { recordingNodeIds: number[] }
        return { json: async () => ({ tracks: body.recordingNodeIds.map(makeTrack) }) } as Response
      }
      if (url.endsWith('/health')) {
        return { json: async () => ({ status: 'ok', libraryRoots: healthRoots }) } as Response
      }
      throw new Error(`usePlayback.error.spec: unexpected fetch ${url}`)
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

const commands = () => invokeMock.mock.calls.map(([cmd]) => cmd as string)

describe('usePlayback when native playback cannot open a file', () => {
  it('shows why, names the expected folder, and never claims the track is playing', async () => {
    const { result, unmount } = renderPlaybackHook()
    for (const id of [10, 20]) unreachablePaths.add(makeTrack(id).filePath)

    await act(async () => {
      await result.current!.playTracks([10, 20], 0, 'Song')
    })

    const playback = result.current!
    expect(playback.status.playing).toBe(false)
    // Nothing else (canvas halo, now-playing panel) should treat it as live…
    expect(playback.status.currentRecordingNodeId).toBeNull()
    // …but the dock stays mounted so the message has somewhere to show.
    expect(playback.currentTitle).toBe('Song')
    expect(playback.problem).toEqual({
      headline: 'The library drive looks disconnected on this machine',
      detail: 'Nothing is at /mnt/music, where “Song” should be. Reconnect or mount the drive, then try again.',
      action: 'retry',
    })
    // Stopped at the first failure: no point opening every other file on a
    // mount that isn't there, and no queue_play for a track that never loaded.
    expect(commands().filter((c) => c === 'queue_enqueue')).toHaveLength(1)
    expect(commands()).not.toContain('queue_play')

    unmount()
  })

  it('says the drive itself is disconnected when /health reports the root unreachable', async () => {
    const { result, unmount } = renderPlaybackHook()
    unreachablePaths.add(makeTrack(10).filePath)
    healthRoots = [{ libraryRootId: 1, path: '/mnt/music', reachable: false }]

    await act(async () => {
      await result.current!.playTracks([10], 0, 'Song')
    })

    expect(result.current!.problem?.headline).toBe('The library drive is disconnected')
    unmount()
  })

  it('plays once the drive is back and play is pressed again, clearing the message', async () => {
    const { result, unmount } = renderPlaybackHook()
    unreachablePaths.add(makeTrack(10).filePath)

    await act(async () => {
      await result.current!.playTracks([10, 20], 0, 'Song')
    })
    expect(result.current!.problem).not.toBeNull()

    unreachablePaths.clear()
    invokeMock.mockClear()
    await act(async () => {
      await result.current!.resume()
    })

    expect(commands()).toEqual(['queue_stop', 'queue_enqueue', 'queue_enqueue', 'queue_play'])
    expect(result.current!.problem).toBeNull()
    expect(result.current!.status.playing).toBe(true)
    expect(result.current!.status.currentRecordingNodeId).toBe(10)
    unmount()
  })

  it('drops a later track that cannot open from up-next and keeps playing the one that can', async () => {
    const { result, unmount } = renderPlaybackHook()
    unreachablePaths.add(makeTrack(20).filePath)

    await act(async () => {
      await result.current!.playTracks([10, 20, 30], 0, 'Song')
    })

    expect(result.current!.problem).toBeNull()
    expect(result.current!.status.playing).toBe(true)
    expect(result.current!.upNext.map((e) => e.recordingNodeId)).toEqual([30])
    unmount()
  })
})
