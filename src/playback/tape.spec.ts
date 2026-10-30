// #408: the tape against a fake MediaSource. The fake SourceBuffer places
// appended fragments the way sequence mode does (each at timestampOffset,
// then straight after the last), refuses past a quota the way iOS's 5 MB
// does, and fails any append that would leave the parser mid-segment:
// media before its track's init segment, or a fragment that skips ahead
// within a track.
import { describe, expect, it, vi } from 'vitest'
import { AHEAD_S, Tape, type MediaSourceLike, type SourceBufferLike, type TapeHost, type TapeTrack } from './tape'
import type { TrackFeed } from './trackFeed'

type Piece = { kind: 'init'; track: string } | { kind: 'media'; track: string; index: number; duration: number }

// What each fake byte array stands for.
const pieces = new WeakMap<Uint8Array, Piece>()

function piece(description: Piece): Uint8Array {
  const bytes = new Uint8Array(1)
  pieces.set(bytes, description)
  return bytes
}

function ranges(list: [number, number][]): TimeRanges {
  return { length: list.length, start: (i: number) => list[i][0], end: (i: number) => list[i][1] }
}

class FakeSourceBuffer extends EventTarget implements SourceBufferLike {
  mode: AppendMode = 'segments'
  updating = false
  // An append or a removal opens an ended source again, as MSE has it.
  parent: FakeMediaSource | null = null
  // Seconds of audio the buffer holds before it refuses more.
  capacityS = Infinity
  intervals: [number, number][] = []
  ops: string[] = []
  types: string[]
  appended: { track: string; index: number; at: number }[] = []
  private cursor = 0
  private offset = 0
  // The track whose init segment came last, and the fragment it expects next.
  private parsing: { track: string; next: number | null } | null = null

  constructor(type: string) {
    super()
    this.types = [type]
  }

  get timestampOffset() {
    return this.offset
  }

  set timestampOffset(value: number) {
    if (this.updating) throw new DOMException('updating', 'InvalidStateError')
    this.offset = value
    this.cursor = value
    this.ops.push(`offset ${value}`)
  }

  get buffered() {
    return ranges(this.intervals)
  }

  get total() {
    return this.intervals.reduce((sum, [start, end]) => sum + end - start, 0)
  }

  appendBuffer(data: BufferSource) {
    if (this.updating) throw new DOMException('updating', 'InvalidStateError')
    this.reopen()
    const what = pieces.get(data as Uint8Array)!
    if (what.kind === 'media' && this.total + what.duration > this.capacityS) throw new DOMException('full', 'QuotaExceededError')
    this.updating = true
    let failed = false
    if (what.kind === 'init') {
      this.parsing = { track: what.track, next: null }
      this.ops.push(`init ${what.track}`)
    } else {
      const parsing = this.parsing
      // Media with no init segment before it, another track's, or not the
      // fragment after the last one: the parser loses its place.
      if (!parsing || parsing.track !== what.track || (parsing.next !== null && parsing.next !== what.index)) failed = true
      else {
        parsing.next = what.index + 1
        this.add(this.cursor, this.cursor + what.duration)
        this.appended.push({ track: what.track, index: what.index, at: this.cursor })
        this.ops.push(`media ${what.track}#${what.index} @${this.cursor}`)
        this.cursor += what.duration
      }
    }
    queueMicrotask(() => {
      this.updating = false
      if (failed) this.dispatchEvent(new Event('error'))
      this.dispatchEvent(new Event('updateend'))
    })
  }

  remove(start: number, end: number) {
    if (this.updating) throw new DOMException('updating', 'InvalidStateError')
    this.reopen()
    this.updating = true
    this.ops.push(`remove ${start}-${end}`)
    this.intervals = this.intervals
      .flatMap(([a, b]): [number, number][] => [
        [a, Math.min(b, start)],
        [Math.max(a, end), b],
      ])
      .filter(([a, b]) => b - a > 1e-9)
    queueMicrotask(() => {
      this.updating = false
      this.dispatchEvent(new Event('updateend'))
    })
  }

  abort() {
    this.ops.push('abort')
    this.parsing = null
    if (this.updating) {
      this.updating = false
      this.dispatchEvent(new Event('abort'))
      this.dispatchEvent(new Event('updateend'))
    }
  }

  changeType(type: string) {
    this.ops.push(`changeType ${type}`)
    this.types.push(type)
    this.parsing = null
  }

  private reopen() {
    if (this.parent?.readyState !== 'ended') return
    this.parent.readyState = 'open'
    this.ops.push('reopened')
  }

  private add(start: number, end: number) {
    const all = [...this.intervals, [start, end] as [number, number]].sort((a, b) => a[0] - b[0])
    const merged: [number, number][] = []
    for (const [a, b] of all) {
      const last = merged.at(-1)
      if (last && a <= last[1] + 1e-9) last[1] = Math.max(last[1], b)
      else merged.push([a, b])
    }
    this.intervals = merged
  }
}

class FakeMediaSource extends EventTarget implements MediaSourceLike {
  readyState: ReadyState = 'closed'
  buffer: FakeSourceBuffer | null = null
  ended = 0

  open() {
    this.readyState = 'open'
    this.dispatchEvent(new Event('sourceopen'))
  }

  addSourceBuffer(type: string) {
    this.buffer = new FakeSourceBuffer(type)
    this.buffer.parent = this
    return this.buffer
  }

  endOfStream() {
    this.readyState = 'ended'
    this.ended += 1
  }
}

class FakeElement extends EventTarget {
  #time = 0
  seeks: number[] = []

  get currentTime() {
    return this.#time
  }

  set currentTime(value: number) {
    this.#time = value
    this.seeks.push(value)
  }

  /** Plays on by `seconds`, as far as there's audio, firing timeupdate. */
  play(seconds: number, buffer: FakeSourceBuffer) {
    const range = buffer.intervals.find(([a, b]) => this.#time >= a - 1e-9 && this.#time < b)
    this.#time = Math.min(this.#time + seconds, range ? range[1] : this.#time)
    this.dispatchEvent(new Event('timeupdate'))
  }
}

// A track `durationS` long in one-second fragments, as the server's rungs
// are, of the given type.
type TrackSpec = { durationS: number; type?: string; failOpen?: Error; failAt?: number }

function feedFor(track: string, spec: TrackSpec, fromS: number, signal: AbortSignal, log: string[]): TrackFeed {
  const first = Math.min(Math.floor(fromS), spec.durationS - 1)
  let next = -1
  log.push(`open ${track} from ${first}`)
  return {
    type: spec.type ?? 'audio/mp4; codecs="fLaC"',
    rung: 'original-fmp4',
    fromTime: first,
    async next() {
      if (signal.aborted) throw new DOMException('aborted', 'AbortError')
      if (next === -1) {
        next = first
        return piece({ kind: 'init', track })
      }
      if (spec.failAt === next) throw new Error('network gone for good')
      if (next >= spec.durationS) return null
      return piece({ kind: 'media', track, index: next++, duration: 1 })
    },
    close() {},
  }
}

function setup(tracks: Record<string, TrackSpec>, order: string[] = Object.keys(tracks)) {
  const element = new FakeElement()
  const mediaSource = new FakeMediaSource()
  const opens: string[] = []
  const signals: AbortSignal[] = []
  const queue = { order: [...order], repeatOne: false }
  const host = {
    after: vi.fn((key: string): TapeTrack<string> | null => {
      if (queue.repeatOne) return { key, fileId: 1 }
      const next = queue.order[queue.order.indexOf(key) + 1]
      return next ? { key: next, fileId: 1 } : null
    }),
    open: vi.fn(async (track: TapeTrack<string>, fromS: number, signal: AbortSignal) => {
      signals.push(signal)
      const spec = tracks[track.key]
      if (spec.failOpen) throw spec.failOpen
      return feedFor(track.key, spec, fromS, signal, opens)
    }),
    onTrackPlaying: vi.fn(),
    onTrackFailed: vi.fn(),
    log: vi.fn(),
  } satisfies TapeHost<string>
  const tape = new Tape<string>(element, mediaSource, host)
  const buffer = () => mediaSource.buffer!
  return { element, mediaSource, host, tape, opens, signals, queue, buffer }
}

// Lets every pump run to where it waits on nothing but the playhead. The
// fakes settle in microtasks, so each timer turn drains whole chains.
async function settle() {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

const track = (key: string): TapeTrack<string> => ({ key, fileId: 1 })

describe('Tape', () => {
  it('appends a track a fragment at a time, about 20 s past the playhead, after its init segment', async () => {
    const { tape, mediaSource, element, buffer } = setup({ a: { durationS: 120 } })
    tape.play(track('a'))
    mediaSource.open()
    await settle()

    expect(buffer().mode).toBe('sequence')
    expect(buffer().ops.slice(0, 3)).toEqual(['offset 0', 'init a', 'media a#0 @0'])
    expect(buffer().appended).toHaveLength(AHEAD_S)
    expect(element.seeks).toEqual([0])

    // Playing on asks for more, a fragment at a time.
    element.play(5, buffer())
    await settle()
    expect(buffer().appended).toHaveLength(AHEAD_S + 5)
    expect(buffer().appended.map((a) => a.index)).toEqual([...Array(AHEAD_S + 5).keys()])
  })

  it("puts the next track in while the current one plays, straight after its end, and says when it's playing", async () => {
    const { tape, mediaSource, element, buffer, host } = setup({ a: { durationS: 10 }, b: { durationS: 30 } })
    tape.play(track('a'))
    mediaSource.open()
    await settle()

    // All of a, and b's first 10 s behind it, before a has played at all.
    expect(buffer().ops).toContain('offset 10')
    expect(buffer().appended.find((a) => a.track === 'b')).toEqual({ track: 'b', index: 0, at: 10 })
    expect(buffer().intervals).toEqual([[0, 20]])

    element.play(1, buffer())
    expect(host.onTrackPlaying).toHaveBeenLastCalledWith('a', true)
    expect(tape.current()).toEqual({ key: 'a', positionS: 1 })
    for (let i = 0; i < 10; i++) {
      element.play(1, buffer())
      await settle()
    }
    expect(host.onTrackPlaying).toHaveBeenLastCalledWith('b', false)
    expect(tape.current()).toEqual({ key: 'b', positionS: 1 })
  })

  it('on QuotaExceededError, removes played audio and puts the same bytes in again later, never skipping ahead', async () => {
    const { tape, mediaSource, element, buffer, host } = setup({ a: { durationS: 120 } })
    tape.play(track('a'))
    // iOS's few megabytes: 12 s here, less than the 20 s the tape wants ahead.
    const addSourceBuffer = mediaSource.addSourceBuffer.bind(mediaSource)
    mediaSource.addSourceBuffer = (type: string) => Object.assign(addSourceBuffer(type), { capacityS: 12 })
    mediaSource.open()
    await settle()
    expect(buffer().appended).toHaveLength(12)
    expect(host.log).toHaveBeenCalledWith('quota', { ranges: [[0, 12]] })

    // As it plays, played audio comes out, and the refused fragment goes
    // in, then each after it, in order: the fake fails any that skips one.
    for (let i = 0; i < 40; i++) {
      element.play(1, buffer())
      await settle()
    }
    expect(buffer().ops.some((op) => /^remove 0-\d/.test(op))).toBe(true)
    const indexes = buffer().appended.map((a) => a.index)
    expect(indexes).toEqual([...Array(indexes.length).keys()])
    expect(indexes.length).toBeGreaterThanOrEqual(40 + 8)
    expect(buffer().total).toBeLessThanOrEqual(12)
    expect(host.onTrackFailed).not.toHaveBeenCalled()
  })

  it('takes a skip by aborting, clearing everything, and putting the track after the furthest point the tape reached', async () => {
    const { tape, mediaSource, element, buffer, host } = setup({ a: { durationS: 30 }, b: { durationS: 30 }, c: { durationS: 30 } })
    tape.play(track('a'))
    mediaSource.open()
    await settle()
    element.play(4, buffer())
    await settle()
    const reached = buffer().intervals.at(-1)![1]

    tape.play(track('c'))
    expect(tape.current()).toEqual({ key: 'c', positionS: 0 })
    await settle()

    const ops = buffer().ops
    const abort = ops.lastIndexOf('abort')
    const removal = ops.findIndex((op, i) => i > abort && op.startsWith('remove'))
    expect(abort).toBeGreaterThan(0)
    expect(removal).toBeGreaterThan(abort)
    expect(ops.slice(removal + 1, removal + 3)).toEqual([`offset ${reached}`, 'init c'])
    expect(element.currentTime).toBe(reached)
    expect(buffer().intervals[0][0]).toBe(reached)

    element.play(0.5, buffer())
    expect(host.onTrackPlaying).toHaveBeenLastCalledWith('c', true)
    expect(tape.current()).toEqual({ key: 'c', positionS: 0.5 })
  })

  it('lands only the last of several quick skips, and drops the fetches of the others', async () => {
    const { tape, mediaSource, element, buffer, host, signals } = setup({
      a: { durationS: 30 },
      b: { durationS: 30 },
      c: { durationS: 30 },
      d: { durationS: 30 },
    })
    tape.play(track('a'))
    mediaSource.open()
    await settle()
    element.play(2, buffer())

    tape.play(track('b'))
    tape.play(track('c'))
    tape.play(track('d'))
    await settle()

    expect(tape.current()?.key).toBe('d')
    element.play(0.5, buffer())
    expect(host.onTrackPlaying).toHaveBeenLastCalledWith('d', true)
    expect(host.onTrackPlaying).not.toHaveBeenCalledWith('b', expect.anything())
    expect(host.onTrackPlaying).not.toHaveBeenCalledWith('c', expect.anything())
    expect(buffer().appended.filter((a) => a.track === 'b' || a.track === 'c')).toEqual([])
    expect(signals.slice(0, -2).every((signal) => signal.aborted)).toBe(true)
  })

  it('scrubs inside what is buffered by moving the playhead, and past it through the fragment holding the target', async () => {
    const { tape, mediaSource, element, buffer, opens } = setup({ a: { durationS: 200 } })
    tape.play(track('a'))
    mediaSource.open()
    await settle()

    tape.seek(12.5)
    expect(element.currentTime).toBe(12.5)
    expect(buffer().ops).not.toContain('abort')

    tape.seek(150.4)
    await settle()
    expect(opens.at(-1)).toBe('open a from 150')
    const start = 20
    // The track keeps its place on the tape: 0:00 at `start`, and the
    // fragment holding 2:30 at start + 150. Nothing before it is fetched.
    expect(buffer().ops).toContain(`offset ${start + 150}`)
    expect(buffer().appended.find((a) => a.at === start + 150)).toEqual({ track: 'a', index: 150, at: start + 150 })
    expect(element.currentTime).toBeCloseTo(start + 150.4)
    element.play(1, buffer())
    expect(tape.current()!.positionS).toBeCloseTo(151.4)
  })

  it('swaps out a next track the queue no longer has next, where it was, ahead of the playhead', async () => {
    const { tape, mediaSource, element, buffer, host, queue } = setup({ a: { durationS: 10 }, b: { durationS: 30 }, c: { durationS: 30 } })
    tape.play(track('a'))
    mediaSource.open()
    await settle()
    expect(buffer().appended.some((a) => a.track === 'b')).toBe(true)

    queue.order = ['a', 'c', 'b']
    tape.queueChanged()
    await settle()

    expect(buffer().ops).toContain('remove 10-Infinity')
    expect(buffer().appended.find((a) => a.track === 'c')).toEqual({ track: 'c', index: 0, at: 10 })
    for (let i = 0; i < 11; i++) {
      element.play(1, buffer())
      await settle()
    }
    expect(host.onTrackPlaying).toHaveBeenLastCalledWith('c', false)
  })

  it('leaves the tape alone when the next track in is still the next one', async () => {
    const { tape, mediaSource, buffer, queue } = setup({ a: { durationS: 10 }, b: { durationS: 30 }, c: { durationS: 30 } })
    tape.play(track('a'))
    mediaSource.open()
    await settle()
    const before = buffer().ops.length

    queue.order = ['a', 'b', 'c']
    tape.queueChanged()
    await settle()
    expect(
      buffer()
        .ops.slice(before)
        .some((op) => op.startsWith('remove') || op === 'abort'),
    ).toBe(false)
  })

  it('repeats a track as a second copy on the tape, and says when the repeat starts', async () => {
    const { tape, mediaSource, element, buffer, host, queue } = setup({ a: { durationS: 5 } })
    queue.repeatOne = true
    tape.play(track('a'))
    mediaSource.open()
    await settle()

    // Four copies fill the 20 s the tape keeps ahead.
    expect(
      buffer()
        .appended.filter((a) => a.index === 0)
        .map((a) => a.at),
    ).toEqual([0, 5, 10, 15])
    element.play(1, buffer())
    host.onTrackPlaying.mockClear()
    for (let i = 0; i < 5; i++) element.play(1, buffer())
    expect(host.onTrackPlaying).toHaveBeenCalledWith('a', false)
    expect(tape.current()).toEqual({ key: 'a', positionS: 1 })
  })

  it('ends the stream once the last track of the queue is in, and leaves it ended as it plays out', async () => {
    const { tape, mediaSource, element, buffer } = setup({ a: { durationS: 15 }, b: { durationS: 15 } })
    tape.play(track('a'))
    mediaSource.open()
    await settle()
    // 30 s of queue, 20 s ahead: all in once 10 s have played.
    for (let i = 0; i < 12; i++) {
      element.play(1, buffer())
      await settle()
    }
    expect(mediaSource.ended).toBe(1)

    // Played audio isn't removed once the stream has ended: a removal would
    // open it again, and the next pump would end it again, round and round.
    for (let i = 0; i < 20; i++) {
      element.play(1, buffer())
      tape.pump('startstreaming')
      await settle()
    }
    expect(mediaSource.ended).toBe(1)
    expect(buffer().ops).not.toContain('reopened')
  })

  it('opens an ended stream again for a track added to the queue after it', async () => {
    const { tape, mediaSource, buffer, queue } = setup({ a: { durationS: 5 }, b: { durationS: 5 } }, ['a'])
    tape.play(track('a'))
    mediaSource.open()
    await settle()
    expect(mediaSource.ended).toBe(1)

    queue.order = ['a', 'b']
    tape.queueChanged()
    await settle()
    expect(buffer().appended.find((a) => a.track === 'b')?.at).toBe(5)
    expect(mediaSource.ended).toBe(2)
  })

  it('changes the codec when the next track is another', async () => {
    const { tape, mediaSource, buffer } = setup({ a: { durationS: 5 }, b: { durationS: 5, type: 'audio/mp4; codecs="alac"' } })
    tape.play(track('a'))
    mediaSource.open()
    await settle()
    expect(buffer().types).toEqual(['audio/mp4; codecs="fLaC"', 'audio/mp4; codecs="alac"'])
    const ops = buffer().ops
    expect(ops.indexOf('changeType audio/mp4; codecs="alac"')).toBeLessThan(ops.indexOf('init b'))
    expect(buffer().appended.find((a) => a.track === 'b')?.at).toBe(5)
  })

  it('reports a next track that fails, and leaves it until the queue changes', async () => {
    const { tape, mediaSource, buffer, host, queue } = setup({
      a: { durationS: 5 },
      b: { durationS: 5, failOpen: new Error('404') },
      c: { durationS: 5 },
    })
    tape.play(track('a'))
    mediaSource.open()
    await settle()
    expect(host.onTrackFailed).toHaveBeenCalledWith('b', expect.any(Error), false)
    expect(host.open).toHaveBeenCalledTimes(2)
    tape.pump('heartbeat')
    await settle()
    expect(host.open).toHaveBeenCalledTimes(2)

    // The host drops it from the queue.
    queue.order = ['a', 'c']
    tape.queueChanged()
    await settle()
    expect(buffer().appended.find((a) => a.track === 'c')?.at).toBe(5)
  })

  it('reports a track a play was waiting for as a failed start', async () => {
    const { tape, mediaSource, host } = setup({ a: { durationS: 5, failOpen: new Error('404') } })
    tape.play(track('a'))
    mediaSource.open()
    await settle()
    expect(host.onTrackFailed).toHaveBeenCalledWith('a', expect.any(Error), true)
    expect(tape.current()).toBeNull()
  })

  it('plays what went in of a track that fails part way, then moves on', async () => {
    const { tape, mediaSource, buffer, host } = setup({ a: { durationS: 10, failAt: 4 }, b: { durationS: 10 } })
    tape.play(track('a'))
    mediaSource.open()
    await settle()
    expect(host.onTrackFailed).toHaveBeenCalledWith('a', expect.any(Error), false)
    expect(buffer().appended.find((a) => a.track === 'b')?.at).toBe(4)
  })
})
