// @vitest-environment jsdom
//
// Issue #185: native playback streams a track from the server when its file
// isn't on this machine. React's half: every queue_enqueue carries the
// server's original-quality stream of the file, with the media ticket, and
// the status follows Rust's word on whether the current track is streaming.
// invoke and listen are mocked as in usePlayback.library.spec.ts.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

function makeTrack(id: number) {
  return {
    recordingNodeId: id,
    fileId: id * 10,
    filePath: `/music/Album/${id}.flac`,
    format: 'flac',
    bitrate: null,
    durationMs: 200_000,
    replaygainTrackGain: -6.5,
    replaygainAlbumGain: null,
  }
}

beforeEach(() => {
  handlers.clear()
  invokeMock.mockReset()
  invokeMock.mockImplementation(async (cmd: string) => (cmd === 'queue_status' ? { volume: 1 } : undefined))
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/queue/resolve')) {
        const body = JSON.parse((init?.body as string) ?? '{}') as { recordingNodeIds: number[] }
        return { json: async () => ({ tracks: body.recordingNodeIds.map(makeTrack) }) } as Response
      }
      if (url.includes('/nodes/')) return { json: async () => ({ title: 'A track' }) } as Response
      throw new Error(`usePlayback.stream.spec: unexpected fetch ${url}`)
    }),
  )
})

afterEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function renderPlaybackHook() {
  vi.resetModules()
  const { storeSession } = await import('../auth/session')
  storeSession({ token: 'session-token', mediaTicket: 'media-ticket' })
  const { usePlayback } = await import('./usePlayback')

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

describe('native playback of a file that may not be here (#185)', () => {
  it("hands Rust the file's path and its original-quality stream, with the media ticket", async () => {
    const { result, unmount } = await renderPlaybackHook()

    await act(async () => {
      await result.current!.playTracks([1, 2], 0, 'One')
    })

    const enqueued = invokeMock.mock.calls.filter(([cmd]) => cmd === 'queue_enqueue').map(([, args]) => args.track)
    expect(enqueued).toHaveLength(2)
    expect(enqueued[0]).toMatchObject({ file_path: '/music/Album/1.flac', recording_node_id: 1, replaygain_track_gain: -6.5 })
    const url = new URL(enqueued[0].stream_url)
    expect(url.pathname).toBe('/api/v1/files/10/stream')
    expect(url.searchParams.get('quality')).toBe('original')
    expect(url.searchParams.get('t')).toBe('media-ticket')
    expect(new URL(enqueued[1].stream_url).pathname).toBe('/api/v1/files/20/stream')
    unmount()
  })

  it("follows Rust's word on whether the current track is streaming", async () => {
    const { result, unmount } = await renderPlaybackHook()
    await act(async () => {
      await result.current!.playTracks([1, 2], 0, 'One')
    })
    expect(result.current!.status.streaming).toBe(false)

    emit('playback://track-changed', { recording_node_id: 1, streaming: true })
    expect(result.current!.status.streaming).toBe(true)

    // The next track was on this machine after all.
    emit('playback://position', { position_ms: 1000, recording_node_id: 2, streaming: false })
    expect(result.current!.status.streaming).toBe(false)

    emit('playback://position', { position_ms: 1250, recording_node_id: 2, streaming: true })
    emit('playback://track-changed', { recording_node_id: null, streaming: false })
    expect(result.current!.status.streaming).toBe(false)
    unmount()
  })
})
