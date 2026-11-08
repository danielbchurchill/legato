// @vitest-environment jsdom
//
// Issue #426: native playback's audio output stopped and playback.rs
// couldn't open another. Rust keeps the session paused where it was and
// says playback://output-lost; the transport shows the same problem as a
// start that found no output, and its retry is a plain play. A seek the
// output didn't carry out in time comes back rejected, and the position
// stays where Rust says it is. invoke and listen are mocked as in
// usePlayback.stream.spec.ts.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativePlaybackError } from './playbackError'

type Handler = (event: { payload: unknown }) => void

const { invokeMock, handlers } = vi.hoisted(() => ({ invokeMock: vi.fn(), handlers: new Map<string, Handler>() }))

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => true,
  invoke: invokeMock,
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((name: string, handler: Handler) => {
    handlers.set(name, handler)
    return Promise.resolve(() => undefined)
  }),
}))

import { usePlayback } from './usePlayback'

const titled = (...ids: number[]) => ids.map((id) => ({ id, title: id === 1 ? 'Song' : `Track ${id}` }))

function makeTrack(id: number) {
  return {
    recordingNodeId: id,
    fileId: id * 10,
    filePath: `/music/Album/${id}.flac`,
    format: 'flac',
    bitrate: null,
    durationMs: 200_000,
    replaygainTrackGain: null,
    replaygainAlbumGain: null,
  }
}

const noOutput: NativePlaybackError = { kind: 'no_output_device', detail: 'Could not find any output device' }

// What queue_play and queue_seek do, set per test.
let playRejects: unknown = null
let seekRejects: unknown = null

beforeEach(() => {
  handlers.clear()
  playRejects = null
  seekRejects = null
  invokeMock.mockReset()
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === 'queue_status') return { volume: 1 }
    if (cmd === 'queue_play' && playRejects) throw playRejects
    if (cmd === 'queue_seek' && seekRejects) throw seekRejects
    return undefined
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/queue/resolve')) {
        const body = JSON.parse((init?.body as string) ?? '{}') as { recordingNodeIds: number[] }
        return { json: async () => ({ tracks: body.recordingNodeIds.map(makeTrack) }) } as Response
      }
      if (url.includes('/nodes/')) return { json: async () => ({ title: 'Song' }) } as Response
      throw new Error(`usePlayback.output.spec: unexpected fetch ${url}`)
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
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

function emit(name: string, payload: unknown) {
  act(() => handlers.get(name)!({ payload }))
}

const commands = () => invokeMock.mock.calls.map(([cmd]) => cmd as string)

async function playingTrackOne() {
  const hook = renderPlaybackHook()
  await act(async () => {
    await hook.result.current!.playTracks(titled(1, 2), 0)
  })
  emit('playback://position', { position_ms: 42_000, recording_node_id: 1, streaming: false })
  return hook
}

describe('native playback when its audio output stops for good (#426)', () => {
  it('says so, keeps the track where it was, and plays on once an output opens', async () => {
    const { result, unmount } = await playingTrackOne()

    emit('playback://output-lost', noOutput)

    expect(result.current!.problem).toEqual({
      headline: 'No audio output device',
      detail: "Legato couldn't open any speaker or headphone output. Connect one, then try again.",
      action: 'retry',
    })
    expect(result.current!.status.playing).toBe(false)
    // Still the current track, at its place: Rust kept the session.
    expect(result.current!.status.currentRecordingNodeId).toBe(1)
    expect(result.current!.status.positionMs).toBe(42_000)

    invokeMock.mockClear()
    await act(async () => {
      await result.current!.resolveProblem()
    })

    // A plain play, which opens an output first: no rebuild, no restart.
    expect(commands()).toEqual(['queue_play'])
    expect(result.current!.problem).toBeNull()
    expect(result.current!.status.playing).toBe(true)
    unmount()
  })

  it('keeps saying so while play still finds no output', async () => {
    const { result, unmount } = await playingTrackOne()
    emit('playback://output-lost', noOutput)
    playRejects = noOutput

    await act(async () => {
      await result.current!.resume()
    })

    expect(result.current!.problem?.headline).toBe('No audio output device')
    expect(result.current!.status.playing).toBe(false)
    unmount()
  })

  it('leaves the position alone when a seek does not land', async () => {
    const { result, unmount } = await playingTrackOne()
    seekRejects = "the audio output didn't carry out the seek within 5 s"
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await act(async () => {
      await result.current!.seek(90_000)
    })

    expect(result.current!.status.positionMs).toBe(42_000)
    expect(warn).toHaveBeenCalledWith('[legato] the seek did not land', seekRejects)
    unmount()
  })
})
