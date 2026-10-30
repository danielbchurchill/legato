import { API_BASE as API } from '../config/serverHost'
import type { ServerTrouble } from './quality'

/* #408: one track's audio for the tape (tape.ts), in the pieces a
 * SourceBuffer takes whole: the init segment first (ftyp and moov), then
 * one fragment (a moof and its mdat) at a time. Appending whole pieces is
 * what lets the tape stop between any two of them: part of a media segment
 * left behind leaves the parser expecting the rest, and every later append
 * then fails silently (the prototype's version 3).
 *
 * Every rung the tape asks for is fragmented MP4 (server/src/stream/
 * quality.ts), and the server names its codec in the Content-Type and its
 * layout at GET /files/:id/stream/index. Two ways in:
 *
 * - From the top, an AAC rung is read as one response, split here by box
 *   headers as it arrives. That doesn't wait for the server's encode to
 *   finish, which on a Raspberry Pi can take a while, and an AAC track is
 *   small enough to hold.
 * - The original (a remux, quick to finish), or any rung from part way
 *   through (a scrub), goes by the index: the init segment and then about a
 *   megabyte of whole fragments at a time, by Range. Nothing before a
 *   scrub's target is fetched, and a 100 MB FLAC never sits in memory whole.
 *
 * A network failure is tried again, from the first byte not yet handed on,
 * for as long as the tape wants the track: an outage pauses the player
 * (quality.ts's watchForStalls), and the audio picks up once the server is
 * back. A file the server can't play is a TrackUnavailable. */

export type TapeRung = 'original-fmp4' | 'aac160' | 'aac256'

export type TrackFeed = {
  /** For addSourceBuffer or changeType: `audio/mp4; codecs="fLaC"`. */
  type: string
  /** What the server is sending, after any fallback below. */
  rung: TapeRung
  /** Where in the track the first fragment starts, in seconds: 0, or the
   * start of the fragment holding a scrub's target. */
  fromTime: number
  /** The init segment, then each fragment; null after the last. */
  next(): Promise<Uint8Array | null>
  close(): void
}

/** The server can't play this file: it's missing, or broken. */
export class TrackUnavailable extends Error {
  readonly status: number

  constructor(status: number) {
    super(`the server can't play this track (${status})`)
    this.name = 'TrackUnavailable'
    this.status = status
  }
}

// The original won't go into a MediaSource as it is: the server refused
// to remux it (415: an MP3, say), or this browser doesn't take its codec.
class CannotRemux extends Error {}

export type FragmentIndex = {
  codecs: string
  initEnd: number
  fragments: { offset: number; time: number }[]
  end: number
}

export type FeedDeps = {
  fetch: typeof fetch
  isTypeSupported: (type: string) => boolean
  /** Settles when it's worth asking again after `attempt` failures: after a
   * backoff, or as soon as the server answers again. Rejects on abort. */
  retryAfter: (attempt: number, signal: AbortSignal) => Promise<void>
  /** How the server has fared since `at` (quality.ts), to tell a broken
   * file's 502 from a server that's away. */
  serverTrouble: (since: number) => Promise<ServerTrouble>
}

export type FeedRequest = { fileId: number; rung: TapeRung; fromS: number; signal: AbortSignal }

// About this much of a track per Range request: nine seconds of 16-bit
// FLAC, three of a 96 kHz one.
export const WINDOW_BYTES = 1024 * 1024

// A response that keeps ending in the same place, this many times over
// with backoff between (a couple of minutes), is the file's fault, not the
// network's.
export const MAX_RESUMES = 10

// The nearest AAC rung to the original, for an original that won't go in.
const FALLBACK: TapeRung = 'aac256'

export function streamPath(fileId: number, rung: TapeRung): string {
  return `${API}/files/${fileId}/stream?quality=${rung}`
}

function indexPath(fileId: number, rung: TapeRung): string {
  return `${API}/files/${fileId}/stream/index?quality=${rung}`
}

export async function openTrackFeed(request: FeedRequest, deps: FeedDeps): Promise<TrackFeed> {
  if (request.rung === 'original-fmp4') {
    try {
      return await openIndexed(request, deps)
    } catch (error) {
      if (!(error instanceof CannotRemux)) throw error
      request = { ...request, rung: FALLBACK }
    }
  }
  return request.fromS > 0 ? openIndexed(request, deps) : openWhole(request, deps)
}

function checkType(type: string, rung: TapeRung, deps: FeedDeps): void {
  if (deps.isTypeSupported(type)) return
  if (rung === 'original-fmp4') throw new CannotRemux()
  throw new TrackUnavailable(415)
}

// A 4xx is the file's own answer, except the few that say "not now". A 5xx
// is the file's own only while the server is answering its health check: a
// relay or a server that's away says the same.
async function failure(status: number, since: number, deps: FeedDeps): Promise<Error | null> {
  if (status === 415) return new CannotRemux()
  if (status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429) return new TrackUnavailable(status)
  if (status >= 500 && (await deps.serverTrouble(since)) === 'none') return new TrackUnavailable(status)
  return null
}

// fetch, asked again after every failure that isn't the file's own.
async function request(url: string, init: RequestInit, signal: AbortSignal, deps: FeedDeps): Promise<Response> {
  const since = Date.now()
  for (let attempt = 0; ; attempt++) {
    let res: Response | null = null
    try {
      res = await deps.fetch(url, { ...init, signal })
    } catch (error) {
      if (signal.aborted) throw error
    }
    if (res?.ok) return res
    if (res) {
      const error = await failure(res.status, since, deps)
      if (error) throw error
    }
    await deps.retryAfter(attempt, signal)
  }
}

/** Bytes [start, end] of the stream, whole, however many tries that takes. */
async function fetchRange(url: string, start: number, end: number, signal: AbortSignal, deps: FeedDeps): Promise<Uint8Array> {
  for (let attempt = 0; ; attempt++) {
    const res = await request(url, { headers: { Range: `bytes=${start}-${end}` } }, signal, deps)
    try {
      const bytes = new Uint8Array(await res.arrayBuffer())
      // A server that ignored the Range sends the whole file.
      const part = res.status === 206 ? bytes : bytes.subarray(start, end + 1)
      if (part.length === end - start + 1) return part
    } catch (error) {
      if (signal.aborted) throw error
    }
    // Cut off part way: the same bytes again.
    await deps.retryAfter(attempt, signal)
  }
}

async function openIndexed({ fileId, rung, fromS, signal }: FeedRequest, deps: FeedDeps): Promise<TrackFeed> {
  const index = (await (await request(indexPath(fileId, rung), {}, signal, deps)).json()) as FragmentIndex
  const type = `audio/mp4; codecs="${index.codecs}"`
  checkType(type, rung, deps)
  const { fragments } = index
  let first = 0
  for (let i = 0; i < fragments.length; i++) if (fragments[i].time <= fromS) first = i
  const url = streamPath(fileId, rung)
  const ready: Uint8Array[] = []
  let nextFragment = first
  let initSent = false

  return {
    type,
    rung,
    fromTime: fragments[first]?.time ?? 0,
    async next() {
      if (!initSent) {
        initSent = true
        return fetchRange(url, 0, index.initEnd - 1, signal, deps)
      }
      if (ready.length === 0) {
        if (nextFragment >= fragments.length) return null
        const from = fragments[nextFragment].offset
        let last = nextFragment
        while (last + 1 < fragments.length && fragments[last + 1].offset - from < WINDOW_BYTES) last++
        const to = last + 1 < fragments.length ? fragments[last + 1].offset : index.end
        const bytes = await fetchRange(url, from, to - 1, signal, deps)
        for (let i = nextFragment; i <= last; i++) {
          const end = i < last ? fragments[i + 1].offset : to
          ready.push(bytes.subarray(fragments[i].offset - from, end - from))
        }
        nextFragment = last + 1
      }
      return ready.shift() ?? null
    },
    close() {},
  }
}

async function openWhole({ fileId, rung, signal }: FeedRequest, deps: FeedDeps): Promise<TrackFeed> {
  const url = streamPath(fileId, rung)
  const res = await request(url, {}, signal, deps)
  const type = res.headers.get('content-type') ?? ''
  // The server reads the codec from the file's own moov. Without it, there's
  // nothing to hand addSourceBuffer but a guess.
  if (!/codecs=/.test(type)) throw new TrackUnavailable(res.status)
  checkType(type, rung, deps)

  const splitter = new BoxSplitter()
  let reader = res.body!.getReader()
  let resumes = 0

  // Picks the stream up again at the first byte not yet handed on.
  async function resume(): Promise<void> {
    void reader.cancel().catch(() => undefined)
    if (resumes >= MAX_RESUMES) throw new TrackUnavailable(res.status)
    await deps.retryAfter(resumes++, signal)
    const again = await request(url, { headers: { Range: `bytes=${splitter.consumed}-` } }, signal, deps)
    splitter.restart(again.status === 206 ? 0 : splitter.consumed)
    reader = again.body!.getReader()
  }

  return {
    type,
    rung,
    fromTime: 0,
    async next() {
      for (;;) {
        const piece = splitter.take()
        if (piece) {
          resumes = 0
          return piece
        }
        let chunk: ReadableStreamReadResult<Uint8Array>
        try {
          chunk = await reader.read()
        } catch (error) {
          if (signal.aborted) throw error
          await resume()
          continue
        }
        if (!chunk.done) {
          splitter.push(chunk.value)
          continue
        }
        if (splitter.buffered === 0) return null
        // Ended part way through a box: cut off.
        await resume()
      }
    },
    close() {
      void reader.cancel().catch(() => undefined)
    },
  }
}

type BoxHeader = { type: string; size: number }

/** Splits a fragmented MP4 byte stream into what a SourceBuffer takes
 * whole: everything before the first moof (the init segment), then each
 * moof with the mdat after it. Anything else between fragments (ffmpeg's
 * closing mfra) is dropped. */
export class BoxSplitter {
  /** The stream offset where the bytes not yet handed on begin. */
  consumed = 0
  private bytes = new Uint8Array(0)
  private initDone = false
  // Bytes still to throw away from what arrives: a resumed request that
  // started from the top again.
  private skip = 0

  get buffered(): number {
    return this.bytes.length
  }

  push(chunk: Uint8Array): void {
    if (this.skip > 0) {
      const dropped = Math.min(this.skip, chunk.length)
      this.skip -= dropped
      chunk = chunk.subarray(dropped)
    }
    if (chunk.length === 0) return
    const joined = new Uint8Array(this.bytes.length + chunk.length)
    joined.set(this.bytes)
    joined.set(chunk, this.bytes.length)
    this.bytes = joined
  }

  /** Drops what's held and takes what comes next as the stream from
   * `consumed`, once `skip` bytes have gone by. */
  restart(skip: number): void {
    this.bytes = new Uint8Array(0)
    this.skip = skip
  }

  take(): Uint8Array | null {
    if (!this.initDone) {
      let at = 0
      for (;;) {
        const box = this.header(at)
        if (!box) return null
        if (box.type === 'moof') break
        at += box.size
      }
      if (at === 0) throw new Error('fragmented MP4 without an init segment')
      this.initDone = true
      return this.emit(at)
    }
    for (;;) {
      const moof = this.header(0)
      if (!moof) return null
      if (moof.type !== 'moof') {
        if (moof.size > this.bytes.length) return null
        this.emit(moof.size)
        continue
      }
      const mdat = this.header(moof.size)
      if (!mdat) return null
      if (mdat.type !== 'mdat') throw new Error(`a moof followed by ${mdat.type}, not mdat`)
      const end = moof.size + mdat.size
      return end > this.bytes.length ? null : this.emit(end)
    }
  }

  private header(at: number): BoxHeader | null {
    if (at + 8 > this.bytes.length) return null
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + at)
    let size = view.getUint32(0)
    const type = String.fromCharCode(...this.bytes.subarray(at + 4, at + 8))
    if (size === 1) {
      if (at + 16 > this.bytes.length) return null
      size = Number(view.getBigUint64(8))
    }
    if (size < 8) throw new Error(`malformed ${type} box`)
    return { type, size }
  }

  private emit(length: number): Uint8Array {
    const piece = this.bytes.slice(0, length)
    this.bytes = this.bytes.subarray(length)
    this.consumed += length
    return piece
  }
}
