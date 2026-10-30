// @vitest-environment jsdom
//
// #408: usePlayback on the tape, where ManagedMediaSource exists. The fake
// server sends each track as fragmented MP4, an index and Range requests,
// in boxes the fake SourceBuffer reads back (a moof's first two bytes say
// which file and which second). The fake element plays over what's
// buffered, and ends where an ended stream does.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false, invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }))

const TRACK_S = 4

function box(type: string, payload: number[] | number = 0): Uint8Array {
  const body = typeof payload === 'number' ? new Uint8Array(payload) : new Uint8Array(payload)
  const out = new Uint8Array(8 + body.length)
  new DataView(out.buffer).setUint32(0, out.length)
  out.set(
    [...type].map((c) => c.charCodeAt(0)),
    4,
  )
  out.set(body, 8)
  return out
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

// One file: an init segment, then a one-second fragment per second.
function fileFor(fileId: number) {
  const init = concat([box('ftyp', 8), box('moov', 40)])
  const fragments = Array.from({ length: TRACK_S }, (_, i) => concat([box('moof', [fileId, i]), box('mdat', 64)]))
  let offset = init.length
  const index = {
    codecs: 'fLaC',
    initEnd: init.length,
    fragments: fragments.map((fragment, i) => {
      const entry = { offset, time: i }
      offset += fragment.length
      return entry
    }),
    end: offset,
  }
  return { bytes: concat([init, ...fragments]), index }
}

class FakeSourceBuffer extends EventTarget {
  mode: AppendMode = 'segments'
  timestampOffset = 0
  updating = false
  intervals: [number, number][] = []
  appended: { fileId: number; second: number; at: number }[] = []
  private cursor = 0
  private lastOffset = 0
  private readonly source: FakeMediaSource
  constructor(source: FakeMediaSource) {
    super()
    this.source = source
  }
  get buffered(): TimeRanges {
    const list = this.intervals
    return { length: list.length, start: (i: number) => list[i][0], end: (i: number) => list[i][1] }
  }
  appendBuffer(data: Uint8Array) {
    if (this.source.readyState === 'ended') this.source.readyState = 'open'
    if (this.timestampOffset !== this.lastOffset) this.cursor = this.lastOffset = this.timestampOffset
    const type = String.fromCharCode(...data.subarray(4, 8))
    if (type === 'moof') {
      this.appended.push({ fileId: data[8], second: data[9], at: this.cursor })
      const last = this.intervals.at(-1)
      if (last && Math.abs(last[1] - this.cursor) < 1e-9) last[1] += 1
      else this.intervals.push([this.cursor, this.cursor + 1])
      this.cursor += 1
      this.lastOffset = this.timestampOffset = this.cursor
    }
    this.updating = true
    queueMicrotask(() => {
      this.updating = false
      this.dispatchEvent(new Event('updateend'))
    })
  }
  remove(start: number, end: number) {
    if (this.source.readyState === 'ended') this.source.readyState = 'open'
    this.intervals = this.intervals
      .flatMap(([a, b]): [number, number][] => [
        [a, Math.min(b, start)],
        [Math.max(a, end), b],
      ])
      .filter(([a, b]) => b - a > 1e-9)
    this.updating = true
    queueMicrotask(() => {
      this.updating = false
      this.dispatchEvent(new Event('updateend'))
    })
  }
  abort() {}
  changeType() {}
}

class FakeMediaSource extends EventTarget {
  static made: FakeMediaSource[] = []
  static isTypeSupported = () => true
  readyState: ReadyState = 'closed'
  buffer: FakeSourceBuffer | null = null
  constructor() {
    super()
    FakeMediaSource.made.push(this)
  }
  open() {
    this.readyState = 'open'
    this.dispatchEvent(new Event('sourceopen'))
  }
  addSourceBuffer() {
    this.buffer = new FakeSourceBuffer(this)
    return this.buffer
  }
  endOfStream() {
    this.readyState = 'ended'
  }
}

class FakeAudio extends EventTarget {
  static made: FakeAudio[] = []
  paused = true
  seeking = false
  error = null
  volume = 1
  src = ''
  disableRemotePlayback = false
  currentTime = 0
  #source: FakeMediaSource | null = null
  constructor() {
    super()
    FakeAudio.made.push(this)
  }
  get srcObject() {
    return this.#source
  }
  set srcObject(value: FakeMediaSource | null) {
    this.#source = value
    if (value) queueMicrotask(() => value.open())
  }
  play = vi.fn(async () => {
    this.paused = false
    this.dispatchEvent(new Event('playing'))
  })
  pause = vi.fn(() => {
    this.paused = true
    this.dispatchEvent(new Event('pause'))
  })
  load() {}
  removeAttribute(name: string) {
    if (name === 'src') this.src = ''
  }
  canPlayType() {
    return 'probably'
  }
  /** Plays on by `seconds` as far as there's audio, and ends at the end of an ended stream. */
  advance(seconds: number) {
    const intervals = this.#source?.buffer?.intervals ?? []
    const range = intervals.find(([a, b]) => this.currentTime >= a - 1e-9 && this.currentTime < b)
    if (!range || this.paused) return
    this.currentTime = Math.min(this.currentTime + seconds, range[1])
    this.dispatchEvent(new Event('timeupdate'))
    if (this.currentTime >= range[1] && this.#source?.readyState === 'ended' && range === intervals.at(-1)) {
      this.paused = true
      this.dispatchEvent(new Event('ended'))
    }
  }
}

const TRACKLIST = [
  { id: 1, title: 'One', track_no: 1, canonical_duration_ms: TRACK_S * 1000 },
  { id: 2, title: 'Two', track_no: 2, canonical_duration_ms: TRACK_S * 1000 },
  { id: 3, title: 'Three', track_no: 3, canonical_duration_ms: TRACK_S * 1000 },
]

const missing = new Set<number>()
const plays: { fileId: number; msPlayed: number }[] = []

function respond(url: string, init?: RequestInit): Response {
  const { pathname, searchParams } = new URL(url)
  if (pathname.endsWith('/queue/resolve')) {
    const { recordingNodeIds } = JSON.parse(init!.body as string) as { recordingNodeIds: number[] }
    return Response.json({
      tracks: recordingNodeIds.map((id) => ({
        recordingNodeId: id,
        fileId: id * 10,
        filePath: `/music/${id}.flac`,
        format: 'flac',
        bitrate: null,
        durationMs: TRACK_S * 1000,
        replaygainTrackGain: null,
        replaygainAlbumGain: null,
      })),
    })
  }
  if (pathname.endsWith('/tracklist')) return Response.json(TRACKLIST)
  if (pathname.endsWith('/plays')) {
    plays.push(JSON.parse(init!.body as string))
    return Response.json({})
  }
  const stream = pathname.match(/\/files\/(\d+)\/stream(\/index)?$/)
  if (stream) {
    const fileId = Number(stream[1])
    expect(searchParams.get('quality')).toBe('original-fmp4')
    if (missing.has(fileId)) return Response.json({ error: 'file not found' }, { status: 404 })
    const { bytes, index } = fileFor(fileId)
    if (stream[2]) return Response.json(index)
    const [start, end] = new Headers(init?.headers).get('Range')!.slice(6).split('-').map(Number)
    return new Response(bytes.slice(start, end + 1), { status: 206 })
  }
  if (pathname.match(/\/nodes\/\d+$/)) return Response.json({ title: 'A track', edges: [] })
  if (pathname.endsWith('/health')) return Response.json({})
  throw new Error(`usePlayback.tape.spec: unexpected fetch ${url}`)
}

let root: Root | null = null

beforeEach(() => {
  FakeAudio.made = []
  FakeMediaSource.made = []
  missing.clear()
  plays.length = 0
  vi.stubGlobal('Audio', FakeAudio)
  vi.stubGlobal('ManagedMediaSource', FakeMediaSource)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => respond(String(input), init)),
  )
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function renderPlayback() {
  vi.resetModules()
  const { setConnectionPath } = await import('../connect/connectionPath')
  setConnectionPath('home')
  const { usePlayback } = await import('./usePlayback')
  const result: { current: ReturnType<typeof usePlayback> | null } = { current: null }
  function Harness() {
    result.current = usePlayback('track')
    return null
  }
  act(() => {
    root = createRoot(document.createElement('div'))
    root.render(createElement(Harness))
  })
  return result as { current: ReturnType<typeof usePlayback> }
}

// Lets fetches, appends and React's updates run out.
async function settle() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

const audio = () => FakeAudio.made.find((a) => a.srcObject)!
const buffer = () => FakeMediaSource.made.at(-1)!.buffer!

async function playFor(seconds: number) {
  for (let i = 0; i < seconds * 2; i++) {
    act(() => audio().advance(0.5))
    await settle()
  }
}

describe('usePlayback on the tape (#408)', () => {
  it('plays the queue from one MediaSource, with remote playback off, the next track going in behind the first', async () => {
    const playback = await renderPlayback()
    await act(async () => {
      await playback.current.playTracks([1, 2, 3], 0, 'One')
    })
    await settle()

    expect(audio().srcObject).toBe(FakeMediaSource.made[0])
    expect(audio().disableRemotePlayback).toBe(true)
    expect(audio().src).toBe('')
    // The whole 12 s queue is in: less than the 20 s the tape keeps ahead.
    expect(buffer().appended.map((a) => [a.fileId, a.at])).toEqual([
      [10, 0],
      [10, 1],
      [10, 2],
      [10, 3],
      [20, 4],
      [20, 5],
      [20, 6],
      [20, 7],
      [30, 8],
      [30, 9],
      [30, 10],
      [30, 11],
    ])
    expect(playback.current.status).toMatchObject({ playing: true, currentRecordingNodeId: 1, currentFileId: 10 })
  })

  it("moves the player on at a track boundary by itself, and reports the play that's over", async () => {
    const playback = await renderPlayback()
    await act(async () => {
      await playback.current.playTracks([1, 2, 3], 0, 'One')
    })
    await settle()
    await playFor(5)

    expect(playback.current.status).toMatchObject({ currentRecordingNodeId: 2, currentFileId: 20, currentDurationMs: TRACK_S * 1000 })
    expect(playback.current.status.positionMs).toBe(1000)
    expect(playback.current.upNext.map((e) => e.recordingNodeId)).toEqual([3])
    // As far as the last position reported inside it, half a second short here.
    expect(plays).toEqual([expect.objectContaining({ fileId: 10, msPlayed: (TRACK_S - 0.5) * 1000 })])
  })

  it('shows a skip at once, and plays on from where it landed', async () => {
    const playback = await renderPlayback()
    await act(async () => {
      await playback.current.playTracks([1, 2, 3], 0, 'One')
    })
    await settle()
    await act(async () => {
      await playback.current.next()
      await playback.current.next()
    })
    expect(playback.current.status.currentRecordingNodeId).toBe(3)
    await settle()
    await playFor(1)
    expect(playback.current.status).toMatchObject({ currentRecordingNodeId: 3, playing: true })
    expect(playback.current.status.positionMs).toBe(1000)
  })

  it("drops a later track the server can't play from up next, and plays the one after it", async () => {
    missing.add(20)
    const playback = await renderPlayback()
    await act(async () => {
      await playback.current.playTracks([1, 2, 3], 0, 'One')
    })
    await settle()

    expect(playback.current.upNext.map((e) => e.recordingNodeId)).toEqual([3])
    expect(
      buffer()
        .appended.filter((a) => a.fileId === 30)
        .map((a) => a.at),
    ).toEqual([4, 5, 6, 7])
    await playFor(5)
    expect(playback.current.status.currentRecordingNodeId).toBe(3)
  })

  it('clears the player at the end of the queue, and stop takes the MediaSource down', async () => {
    const playback = await renderPlayback()
    await act(async () => {
      await playback.current.playTracks([1, 2], 0, 'One')
    })
    await settle()
    await playFor(9)
    expect(playback.current.status).toMatchObject({ playing: false, currentRecordingNodeId: null })

    await act(async () => {
      await playback.current.playTracks([3], 0, 'Three')
    })
    await settle()
    // A queue after one that ended gets a MediaSource of its own.
    expect(FakeMediaSource.made).toHaveLength(2)
    const element = audio()
    await act(async () => {
      await playback.current.stop()
    })
    expect(element.srcObject).toBeNull()
    expect(playback.current.status.currentRecordingNodeId).toBeNull()
  })
})
