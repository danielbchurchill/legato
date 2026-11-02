// @vitest-environment jsdom
//
// #438: previous restarts the track more than PREVIOUS_RESTARTS_AFTER_MS
// in, and always on the queue's first track; within that, it goes back a
// track. Native playback (invoke and listen mocked, as in
// usePlayback.stream.spec.ts) and the plain <audio> player are here; the
// tape's are in usePlayback.tape.spec.ts.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: { payload: unknown }) => void

const { invokeMock, handlers, runtime } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  handlers: new Map<string, Handler>(),
  runtime: { tauri: true },
}))

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => runtime.tauri, invoke: invokeMock }))
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
    filePath: `/music/${id}.flac`,
    format: 'flac',
    bitrate: null,
    durationMs: 200_000,
    replaygainTrackGain: null,
    replaygainAlbumGain: null,
  }
}

class FakeAudio extends EventTarget {
  static made: FakeAudio[] = []
  error = null
  paused = true
  seeking = false
  volume = 1
  currentTime = 0
  #src = ''
  constructor() {
    super()
    FakeAudio.made.push(this)
  }
  get src() {
    return this.#src
  }
  set src(value: string) {
    this.#src = value
    this.currentTime = 0
  }
  play = vi.fn(async () => {
    this.paused = false
    this.dispatchEvent(new Event('playing'))
  })
  pause = vi.fn(() => {
    this.paused = true
    this.dispatchEvent(new Event('pause'))
  })
  canPlayType() {
    return 'probably'
  }
  load() {}
  removeAttribute(name: string) {
    if (name === 'src') this.#src = ''
  }
}

const plays: { fileId: number; msPlayed: number }[] = []
let root: Root | null = null

beforeEach(() => {
  handlers.clear()
  plays.length = 0
  FakeAudio.made = []
  invokeMock.mockReset()
  invokeMock.mockImplementation(async (cmd: string) => (cmd === 'queue_status' ? { volume: 1 } : undefined))
  vi.stubGlobal('Audio', FakeAudio)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/queue/resolve')) {
        const body = JSON.parse(init!.body as string) as { recordingNodeIds: number[] }
        return { ok: true, json: async () => ({ tracks: body.recordingNodeIds.map(makeTrack) }) } as Response
      }
      if (url.endsWith('/plays')) {
        plays.push(JSON.parse(init!.body as string))
        return { ok: true, json: async () => ({}) } as Response
      }
      if (url.includes('/nodes/')) return { ok: true, json: async () => ({ title: 'A track' }) } as Response
      throw new Error(`usePlayback.previous.spec: unexpected fetch ${url}`)
    }),
  )
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  vi.unstubAllGlobals()
})

async function renderPlayback(tauri: boolean) {
  runtime.tauri = tauri
  vi.resetModules()
  const { usePlayback, PREVIOUS_RESTARTS_AFTER_MS } = await import('./usePlayback')
  const result: { current: ReturnType<typeof usePlayback> | null } = { current: null }
  function Harness() {
    result.current = usePlayback('track')
    return null
  }
  act(() => {
    root = createRoot(document.createElement('div'))
    root.render(createElement(Harness))
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return { playback: result as { current: ReturnType<typeof usePlayback> }, line: PREVIOUS_RESTARTS_AFTER_MS }
}

const calls = () => invokeMock.mock.calls.map(([cmd, args]) => [cmd, (args as { positionMs?: number } | undefined)?.positionMs])

describe('previous on native playback (#438)', () => {
  // Rust's word on where the track is, as its monitor thread sends it.
  function at(positionMs: number, recordingNodeId: number) {
    act(() =>
      handlers.get('playback://position')!({ payload: { position_ms: positionMs, recording_node_id: recordingNodeId, streaming: false } }),
    )
  }

  async function playing(startIndex: number) {
    const harness = await renderPlayback(true)
    await act(async () => {
      await harness.playback.current.playTracks([1, 2, 3], startIndex, 'A track')
    })
    act(() => handlers.get('playback://track-changed')!({ payload: { recording_node_id: startIndex + 1, streaming: false } }))
    invokeMock.mockClear()
    return harness
  }

  it('restarts the track when more than the line in, with a seek, and reports the play so far', async () => {
    const { playback, line } = await playing(1)
    at(line + 1, 2)
    await act(async () => {
      await playback.current.previous()
    })

    expect(calls()).toEqual([['queue_seek', 0]])
    expect(playback.current.status).toMatchObject({ currentRecordingNodeId: 2, positionMs: 0 })
    expect(plays).toEqual([expect.objectContaining({ fileId: 20, msPlayed: line + 1 })])
  })

  it('goes back a track at the line or within it', async () => {
    const { playback, line } = await playing(1)
    at(line, 2)
    await act(async () => {
      await playback.current.previous()
    })

    expect(calls()).toEqual([
      ['queue_stop', undefined],
      ['queue_enqueue', undefined],
      ['queue_enqueue', undefined],
      ['queue_enqueue', undefined],
      ['queue_play', undefined],
    ])
    expect(playback.current.status.currentRecordingNodeId).toBe(1)
  })

  it("always restarts the queue's first track, however near its start", async () => {
    const { playback } = await playing(0)
    at(500, 1)
    await act(async () => {
      await playback.current.previous()
    })

    expect(calls()).toEqual([['queue_seek', 0]])
    expect(playback.current.status).toMatchObject({ currentRecordingNodeId: 1, positionMs: 0 })
  })

  it('a second press, once restarted, goes back a track', async () => {
    const { playback, line } = await playing(2)
    at(line * 4, 3)
    await act(async () => {
      await playback.current.previous()
    })
    at(200, 3)
    await act(async () => {
      await playback.current.previous()
    })

    expect(calls().map(([cmd]) => cmd)).toEqual(['queue_seek', 'queue_stop', 'queue_enqueue', 'queue_enqueue', 'queue_play'])
    expect(playback.current.status.currentRecordingNodeId).toBe(2)
  })

  it('a second press queued behind the restart, before anything renders, goes back a track', async () => {
    const { playback, line } = await playing(2)
    at(line * 4, 3)
    await act(async () => {
      await Promise.all([playback.current.previous(), playback.current.previous()])
    })

    expect(calls().map(([cmd]) => cmd)).toEqual(['queue_seek', 'queue_stop', 'queue_enqueue', 'queue_enqueue', 'queue_play'])
    expect(playback.current.status.currentRecordingNodeId).toBe(2)
  })
})

describe('previous on the plain <audio> player (#438)', () => {
  async function playing(startIndex: number) {
    const harness = await renderPlayback(false)
    await act(async () => {
      await harness.playback.current.playTracks([1, 2, 3], startIndex, 'A track')
    })
    return { ...harness, audio: FakeAudio.made[0] }
  }

  function playTo(audio: FakeAudio, positionMs: number) {
    act(() => {
      audio.currentTime = positionMs / 1000
      audio.dispatchEvent(new Event('timeupdate'))
    })
  }

  it('restarts the track when more than the line in, on the same source', async () => {
    const { playback, line, audio } = await playing(1)
    const source = audio.src
    playTo(audio, line + 250)
    await act(async () => {
      await playback.current.previous()
    })

    expect(audio.src).toBe(source)
    expect(audio.currentTime).toBe(0)
    expect(playback.current.status).toMatchObject({ currentRecordingNodeId: 2, positionMs: 0 })
    expect(plays).toEqual([expect.objectContaining({ fileId: 20, msPlayed: line + 250 })])
  })

  it('goes back a track within the line', async () => {
    const { playback, line, audio } = await playing(1)
    playTo(audio, line - 250)
    await act(async () => {
      await playback.current.previous()
    })

    expect(audio.src).toContain('/files/10/stream')
    expect(playback.current.status.currentRecordingNodeId).toBe(1)
  })

  it("always restarts the queue's first track", async () => {
    const { playback, audio } = await playing(0)
    const source = audio.src
    playTo(audio, 1000)
    await act(async () => {
      await playback.current.previous()
    })

    expect(audio.src).toBe(source)
    expect(audio.currentTime).toBe(0)
    expect(playback.current.status).toMatchObject({ currentRecordingNodeId: 1, positionMs: 0 })
  })

  it('reads the element, not a timeupdate that never came while the phone was locked', async () => {
    const { playback, line, audio } = await playing(1)
    playTo(audio, 500)
    // Played on with nothing in the page running.
    audio.currentTime = (line + 5000) / 1000
    await act(async () => {
      await playback.current.previous()
    })

    expect(playback.current.status.currentRecordingNodeId).toBe(2)
    expect(audio.currentTime).toBe(0)
  })
})
