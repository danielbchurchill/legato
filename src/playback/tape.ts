import type { TrackFeed } from './trackFeed'

/* #408: locked, an installed iPhone web app is suspended once its audio
 * stops, so nothing in the page gets to start the next track at the end of
 * the last one. Where ManagedMediaSource exists, the web player therefore
 * plays the whole queue from one MediaSource: each next track's audio goes
 * in while the one before it is still playing, and the element plays
 * straight on from one into the next. Gapless follows.
 *
 * The prototype that passed on the phone (#408's comment of 2026-10-30)
 * set the rules this follows:
 *
 * 1. A track goes in a fragment at a time, only while less than AHEAD_S is
 *    buffered past the playhead. iOS holds about 5 MB: 46 s of 16-bit
 *    FLAC, 16 s of a 96 kHz one.
 * 2. A QuotaExceededError removes played audio, and the same bytes go in
 *    again on a later pump. Never anything after them: part of a media
 *    segment left behind leaves the parser expecting the rest.
 * 3. The media timeline is a tape that only grows. A skip aborts, removes
 *    everything buffered, and puts the track it wants after the furthest
 *    point the tape has reached, in sequence mode with timestampOffset set,
 *    then moves the playhead there. `segments` maps the tape back to the
 *    queue.
 * 4. A scrub past what's buffered starts the track again from the
 *    fragment holding the target (trackFeed.ts), not from its start.
 *
 * Rules 5 and 6 (the playback state after every position, and remote
 * playback off) are mediaSession.ts's and tapePlayer.ts's.
 *
 * The one cut that isn't a skip: when the queue changes after the next
 * track has gone in, what follows the playing track is removed and the new
 * next one goes in where it was. That's all ahead of the playhead and never
 * played, so nothing is appended behind it.
 *
 * The tape knows queue entries only as keys, and its host says what
 * follows each (repeat included), opens each track's feed, and hears which
 * one is playing. */

/** How far past the playhead the tape fills. */
export const AHEAD_S = 20
/** Played audio older than this is removed as the tape goes. */
export const KEEP_BEHIND_S = 5

export type SourceBufferLike = EventTarget & {
  mode: AppendMode
  timestampOffset: number
  readonly updating: boolean
  readonly buffered: TimeRanges
  appendBuffer(data: BufferSource): void
  remove(start: number, end: number): void
  abort(): void
  changeType(type: string): void
}

export type MediaSourceLike = EventTarget & {
  readonly readyState: ReadyState
  addSourceBuffer(type: string): SourceBufferLike
  endOfStream(): void
}

export type TapeElement = EventTarget & { currentTime: number }

export type TapeTrack<K> = { key: K; fileId: number }

export type TapeHost<K> = {
  /** What plays after `key`, as the queue and the repeat mode have it now. */
  after(key: K): TapeTrack<K> | null
  /** One track's audio, from the fragment holding `fromS` on. */
  open(track: TapeTrack<K>, fromS: number, signal: AbortSignal): Promise<TrackFeed>
  /** The playhead is in this track's audio now: where a play, skip or
   * scrub landed (`landed`), or the tape playing on into it. */
  onTrackPlaying(key: K, landed: boolean): void
  /** A track couldn't be fed. `starting` when it's the one a play, skip or
   * scrub was waiting for; otherwise it was on its way in behind another. */
  onTrackFailed(key: K, error: unknown, starting: boolean): void
  log(event: string, detail?: Record<string, unknown>): void
}

type Segment<K> = {
  track: TapeTrack<K>
  /** Where the track's 0:00 is on the tape. */
  start: number
  /** Where its audio ends on the tape, once all of it has gone in. */
  end: number | null
  /** Put there by a play, skip or scrub, not by the tape running on. */
  landed: boolean
}

type Feeding<K> = {
  segment: Segment<K>
  offsetS: number
  generation: number
  controller: AbortController
  feed: TrackFeed | null
  /** Refused for quota: it goes in again before anything after it. */
  pending: Uint8Array | null
  initDone: boolean
  mediaStarted: boolean
  /** A play, skip or scrub is waiting for this track's first audio. */
  landing: boolean
}

function isQuota(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'QuotaExceededError'
}

function describe(error: unknown): Record<string, unknown> {
  return error instanceof Error ? { name: error.name, message: error.message } : { error: String(error) }
}

// Settles when the buffer's update is over; an error event rejects.
function settled(target: EventTarget): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (event: Event) => {
      target.removeEventListener('updateend', done)
      target.removeEventListener('error', done)
      if (event.type === 'error') reject(new Error('the SourceBuffer refused the audio'))
      else resolve()
    }
    target.addEventListener('updateend', done)
    target.addEventListener('error', done)
  })
}

const round = (n: number) => Math.round(n * 100) / 100

export class Tape<K> {
  private sourceBuffer: SourceBufferLike | null = null
  private type: string | null = null
  private segments: Segment<K>[] = []
  private feeding: Feeding<K> | null = null
  // The furthest the tape has reached: where the next skip's track goes.
  // Not the buffered end, which a skip's clearing takes back to nothing.
  private tapeEnd = 0
  private request: { track: TapeTrack<K>; offsetS: number } | null = null
  // Where a play, skip or scrub is going, until its audio is in.
  private heading: { track: TapeTrack<K>; offsetS: number } | null = null
  // Where the queue changed under tracks already in: cut from here.
  private cutAt: number | null = null
  private generation = 0
  private pumping = false
  private again = false
  private playing: Segment<K> | null = null
  // A next track that failed: not tried again until the queue changes.
  private failedNext: K | null = null
  private readonly opened: Promise<void>
  private destroyed = false
  private readonly element: TapeElement
  private readonly mediaSource: MediaSourceLike
  private readonly host: TapeHost<K>

  constructor(element: TapeElement, mediaSource: MediaSourceLike, host: TapeHost<K>) {
    this.element = element
    this.mediaSource = mediaSource
    this.host = host
    this.opened =
      mediaSource.readyState === 'open'
        ? Promise.resolve()
        : new Promise((resolve) => mediaSource.addEventListener('sourceopen', () => resolve(), { once: true }))
    element.addEventListener('timeupdate', this.onTimeUpdate)
    // ManagedMediaSource asks for more when it wants it.
    mediaSource.addEventListener('startstreaming', this.onStartStreaming)
  }

  /** Plays `track` from `offsetS` in: a new queue, a skip, or a scrub that
   * needs audio the tape doesn't have. Whatever was being fed is dropped. */
  play(track: TapeTrack<K>, offsetS = 0): void {
    this.generation += 1
    this.request = { track, offsetS }
    this.heading = { track, offsetS }
    this.failedNext = null
    this.cutAt = null
    this.cancelFeeding()
    if (this.sourceBuffer?.updating && this.mediaSource.readyState === 'open') {
      try {
        this.sourceBuffer.abort()
      } catch (error) {
        // Mid-removal: the pump's clearing goes after it.
        this.host.log('abort-refused', describe(error))
      }
    }
    this.host.log('play', { offsetS: round(offsetS) })
    this.pump('play')
  }

  /** Moves to `offsetS` in the track playing (or on its way): straight
   * there when it's buffered, through the fragment index when it isn't. */
  seek(offsetS: number): void {
    if (this.heading) {
      this.play(this.heading.track, offsetS)
      return
    }
    const segment = this.segmentAt(this.element.currentTime)
    if (!segment) return
    const target = segment.start + offsetS
    if (this.isBuffered(target)) this.element.currentTime = target
    else this.play(segment.track, offsetS)
  }

  /** The track at the playhead and how far into it, or where a skip is
   * going until it lands. */
  current(): { key: K; positionS: number } | null {
    if (this.heading) return { key: this.heading.track.key, positionS: this.heading.offsetS }
    const segment = this.segmentAt(this.element.currentTime)
    if (!segment) return null
    return { key: segment.track.key, positionS: Math.max(0, this.element.currentTime - segment.start) }
  }

  /** The queue or the repeat mode changed. If the track already going in
   * after the playing one isn't what follows it now, it comes out. */
  queueChanged(): void {
    this.failedNext = null
    if (this.heading) return
    const playing = this.segmentAt(this.element.currentTime)
    const following = playing ? this.segments[this.segments.indexOf(playing) + 1] : undefined
    if (playing && following && following.track.key !== this.host.after(playing.track.key)?.key) {
      this.generation += 1
      this.cancelFeeding()
      this.cutAt = following.start
      this.host.log('cut', { at: round(following.start) })
    }
    this.pump('queue')
  }

  /** Feeds the tape if it wants feeding. Cheap to call often: the element's
   * timeupdate does, and the player's heartbeat. */
  pump(reason: string): void {
    if (this.destroyed) return
    if (this.pumping) {
      this.again = true
      return
    }
    this.pumping = true
    this.run()
      .catch((error: unknown) => this.host.log('pump-failed', { reason, ...describe(error) }))
      .finally(() => {
        this.pumping = false
        if (this.again && !this.destroyed) {
          this.again = false
          this.pump('again')
        }
      })
  }

  /** The whole queue is in and the stream has been ended. */
  get ended(): boolean {
    return this.mediaSource.readyState === 'ended'
  }

  destroy(): void {
    this.destroyed = true
    this.generation += 1
    this.cancelFeeding()
    this.element.removeEventListener('timeupdate', this.onTimeUpdate)
    this.mediaSource.removeEventListener('startstreaming', this.onStartStreaming)
  }

  private onTimeUpdate = () => {
    if (!this.heading) {
      const segment = this.segmentAt(this.element.currentTime)
      if (segment && segment !== this.playing) {
        this.playing = segment
        this.host.log('track-playing', { at: round(segment.start), landed: segment.landed })
        this.host.onTrackPlaying(segment.track.key, segment.landed)
      }
    }
    this.pump('timeupdate')
  }

  private onStartStreaming = () => this.pump('startstreaming')

  private async run(): Promise<void> {
    await this.opened
    // An abort() that came mid-removal leaves the removal to finish.
    if (this.sourceBuffer?.updating) await settled(this.sourceBuffer).catch(() => undefined)
    if (this.destroyed) return
    if (this.cutAt !== null && !this.request) {
      const at = this.cutAt
      this.cutAt = null
      await this.removeFrom(at)
    }
    if (this.request) {
      const { track, offsetS } = this.request
      this.request = null
      await this.clearAll()
      // Another skip came while this one was clearing: that one goes next.
      if (this.request || this.destroyed) return
      this.startFeeding(track, offsetS, true)
    } else if (this.mediaSource.readyState === 'open') {
      // Not once the stream has ended: nothing more goes in to make room
      // for, and a removal opens an ended source again, for the next pump
      // to end once more. In WebKit that ran as a loop.
      await this.trimBehind(KEEP_BEHIND_S)
    }

    while (!this.destroyed && !this.request && this.cutAt === null) {
      if (!this.feeding) {
        if (this.heading || this.ahead() >= AHEAD_S) break
        const last = this.segments.at(-1)
        if (!last || last.end === null) break
        const next = this.host.after(last.track.key)
        if (!next) {
          this.endIfDone()
          break
        }
        if (next.key === this.failedNext) break
        this.startFeeding(next, 0, false)
      }
      if (!(await this.feedOne())) break
    }
  }

  private startFeeding(track: TapeTrack<K>, offsetS: number, landing: boolean): void {
    const start = Math.max(this.tapeEnd, this.bufferedEnd())
    const segment: Segment<K> = { track, start, end: null, landed: landing }
    this.segments.push(segment)
    this.feeding = {
      segment,
      offsetS,
      generation: this.generation,
      controller: new AbortController(),
      feed: null,
      pending: null,
      initDone: false,
      mediaStarted: false,
      landing,
    }
    this.host.log('feed', { start: round(start), offsetS: round(offsetS) })
  }

  // One piece of the track being fed: its init segment, or one fragment.
  // False when there's nothing more to do for now.
  private async feedOne(): Promise<boolean> {
    const feeding = this.feeding!
    const stale = () => this.feeding !== feeding || feeding.generation !== this.generation || this.destroyed

    if (!feeding.feed) {
      try {
        feeding.feed = await this.host.open(feeding.segment.track, feeding.offsetS, feeding.controller.signal)
      } catch (error) {
        return !stale() && this.fail(feeding, error)
      }
      if (stale()) {
        feeding.feed.close()
        return false
      }
      this.host.log('opened', { type: feeding.feed.type, rung: feeding.feed.rung, fromTime: round(feeding.feed.fromTime) })
    }
    const feed = feeding.feed
    if (feeding.mediaStarted && this.ahead() >= AHEAD_S) return false

    let bytes = feeding.pending
    if (!bytes) {
      try {
        bytes = await feed.next()
      } catch (error) {
        return !stale() && this.fail(feeding, error)
      }
      if (stale()) return false
      if (bytes === null) {
        this.finish(feeding)
        return true
      }
    }

    try {
      if (!feeding.initDone) this.prepareFor(feeding, feed)
      await this.append(bytes)
    } catch (error) {
      if (stale()) return false
      if (isQuota(error)) {
        feeding.pending = bytes
        this.host.log('quota', { ranges: this.ranges() })
        await this.trimBehind(1)
        return false
      }
      return this.fail(feeding, error)
    }
    feeding.pending = null
    if (stale()) return false
    if (!feeding.initDone) {
      feeding.initDone = true
      return true
    }
    this.tapeEnd = Math.max(this.tapeEnd, this.bufferedEnd())
    if (!feeding.mediaStarted) {
      feeding.mediaStarted = true
      if (feeding.landing) this.land(feeding, feed)
    }
    return true
  }

  // Ready for a track's init segment: the buffer made, or told the codec
  // when it's another, and the track placed on the tape. In sequence mode
  // the next frames land at timestampOffset whatever their own timestamps,
  // so a track fed from part way through still sits where it would have.
  private prepareFor(feeding: Feeding<K>, feed: TrackFeed): void {
    if (!this.sourceBuffer) {
      this.sourceBuffer = this.mediaSource.addSourceBuffer(feed.type)
      this.sourceBuffer.mode = 'sequence'
    } else if (feed.type !== this.type) {
      this.sourceBuffer.changeType(feed.type)
    }
    this.type = feed.type
    this.sourceBuffer.timestampOffset = feeding.segment.start + feed.fromTime
  }

  private append(bytes: Uint8Array): Promise<void> {
    const sourceBuffer = this.sourceBuffer!
    sourceBuffer.appendBuffer(bytes as Uint8Array<ArrayBuffer>)
    return settled(sourceBuffer)
  }

  // A play, skip or scrub's first audio is in: the playhead goes to it.
  private land(feeding: Feeding<K>, feed: TrackFeed): void {
    this.heading = null
    const target = feeding.segment.start + Math.max(feeding.offsetS, feed.fromTime)
    this.element.currentTime = target
    this.host.log('landed', { at: round(target) })
  }

  private finish(feeding: Feeding<K>): void {
    feeding.feed?.close()
    this.feeding = null
    if (!feeding.mediaStarted) {
      this.fail(feeding, new Error('the track has no audio'))
      return
    }
    feeding.segment.end = this.bufferedEnd()
    this.tapeEnd = Math.max(this.tapeEnd, feeding.segment.end)
    this.host.log('appended', { end: round(feeding.segment.end), ranges: this.ranges() })
  }

  // True when the tape can carry straight on with whatever follows.
  private fail(feeding: Feeding<K>, error: unknown): boolean {
    feeding.feed?.close()
    if (this.feeding === feeding) this.feeding = null
    const key = feeding.segment.track.key
    const starting = feeding.landing && !feeding.mediaStarted
    this.host.log('feed-failed', { starting, ...describe(error) })
    if (feeding.mediaStarted) {
      // Part of it is in: that much plays, then whatever follows.
      feeding.segment.end = this.bufferedEnd()
    } else {
      this.segments = this.segments.filter((segment) => segment !== feeding.segment)
      if (starting) this.heading = null
      else this.failedNext = key
    }
    this.host.onTrackFailed(key, error, starting)
    return feeding.mediaStarted
  }

  private cancelFeeding(): void {
    if (!this.feeding) return
    this.feeding.controller.abort()
    this.feeding.feed?.close()
    this.feeding = null
  }

  // Everything out, for a skip: the playhead is about to move past it all.
  // abort() first, so a track left part way doesn't leave the parser in
  // the middle of a segment.
  private async clearAll(): Promise<void> {
    const sourceBuffer = this.sourceBuffer
    this.segments = []
    this.playing = null
    if (!sourceBuffer) return
    this.tapeEnd = Math.max(this.tapeEnd, this.bufferedEnd())
    if (this.mediaSource.readyState === 'open') sourceBuffer.abort()
    if (sourceBuffer.buffered.length === 0) return
    // From 0, not from the first buffered start: that comes back rounded,
    // and in WebKit a frame timed a hair before it stayed behind.
    sourceBuffer.remove(0, Infinity)
    await settled(sourceBuffer)
  }

  // Everything from `at` on, for a queue change after the playing track.
  private async removeFrom(at: number): Promise<void> {
    const sourceBuffer = this.sourceBuffer
    this.segments = this.segments.filter((segment) => segment.start < at)
    this.tapeEnd = at
    if (!sourceBuffer) return
    if (this.mediaSource.readyState === 'open') sourceBuffer.abort()
    if (this.bufferedEnd() <= at) return
    sourceBuffer.remove(at, Infinity)
    await settled(sourceBuffer)
  }

  // Removes played audio more than `keepS` behind the playhead.
  private async trimBehind(keepS: number): Promise<void> {
    const sourceBuffer = this.sourceBuffer
    if (!sourceBuffer || sourceBuffer.buffered.length === 0) return
    const start = sourceBuffer.buffered.start(0)
    const cut = this.element.currentTime - keepS
    if (cut - start < 1) return
    // From 0, as clearAll removes, so nothing timed just before the
    // rounded start is left behind.
    sourceBuffer.remove(0, cut)
    await settled(sourceBuffer)
    const playing = this.segmentAt(this.element.currentTime)
    this.segments = this.segments.filter((segment) => segment === playing || segment.end === null || segment.end > cut)
    this.host.log('trimmed', { from: round(start), to: round(cut) })
  }

  private endIfDone(): void {
    if (this.mediaSource.readyState !== 'open' || this.sourceBuffer?.updating) return
    this.mediaSource.endOfStream()
    this.host.log('end-of-stream')
  }

  private segmentAt(position: number): Segment<K> | null {
    let found: Segment<K> | null = null
    for (const segment of this.segments) if (segment.start <= position + 0.05) found = segment
    return found
  }

  private bufferedEnd(): number {
    const buffered = this.sourceBuffer?.buffered
    return buffered && buffered.length ? buffered.end(buffered.length - 1) : 0
  }

  private ahead(): number {
    return this.bufferedEnd() - this.element.currentTime
  }

  private isBuffered(position: number): boolean {
    const buffered = this.sourceBuffer?.buffered
    if (!buffered) return false
    for (let i = 0; i < buffered.length; i++) if (position >= buffered.start(i) && position < buffered.end(i) - 0.25) return true
    return false
  }

  private ranges(): number[][] {
    const buffered = this.sourceBuffer?.buffered
    if (!buffered) return []
    return Array.from({ length: buffered.length }, (_, i) => [round(buffered.start(i)), round(buffered.end(i))])
  }
}
