import { SERVER_ANSWERED_EVENT, SERVER_BACK_EVENT } from '../connect/reconnect'
import { nextTapeRung, serverTroubleNow } from './quality'
import { Tape, type MediaSourceLike, type TapeTrack } from './tape'
import { openTrackFeed, type FeedDeps, type TapeRung } from './trackFeed'

/* #408: the tape (tape.ts) on the web player's one <audio> element. Where
 * ManagedMediaSource exists (iOS 17.1 and later, Safari 17 and later on a
 * Mac), usePlayback plays through this. Everywhere else (Chrome, Firefox,
 * Android) it keeps setting the element's src per track: Chrome's Opus
 * rungs are Ogg, which a MediaSource doesn't take.
 *
 * This part holds what the tape needs from the page: the MediaSource it
 * plays from, a heartbeat that keeps it fed while nothing else is
 * happening (the prototype's ran every 5 s, and arrived every 6 s with the
 * phone locked), and its fetches, which wait out an outage and try again
 * as soon as the server answers. */

type MediaSourceClass = { new (): MediaSource; isTypeSupported(type: string): boolean }

function managedMediaSource(): MediaSourceClass | undefined {
  return typeof window === 'undefined' ? undefined : (window as unknown as { ManagedMediaSource?: MediaSourceClass }).ManagedMediaSource
}

/** Whether the web player plays through the tape here. */
export function canUseTape(): boolean {
  return managedMediaSource() !== undefined
}

const HEARTBEAT_MS = 5000
const WAKE_EVENTS = [SERVER_ANSWERED_EVENT, SERVER_BACK_EVENT, 'online']
// Between tries at a server that's away: doubling from 1 s, up to 15 s,
// and sooner once it answers again.
const RETRY_MAX_MS = 15_000

function retryAfter(attempt: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const wake = () => {
      cleanup()
      resolve()
    }
    const abort = () => {
      cleanup()
      reject(signal.reason ?? new DOMException('aborted', 'AbortError'))
    }
    const timer = setTimeout(wake, Math.min(1000 * 2 ** attempt, RETRY_MAX_MS))
    const cleanup = () => {
      clearTimeout(timer)
      for (const event of WAKE_EVENTS) window.removeEventListener(event, wake)
      signal.removeEventListener('abort', abort)
    }
    for (const event of WAKE_EVENTS) window.addEventListener(event, wake)
    signal.addEventListener('abort', abort)
    if (signal.aborted) abort()
  })
}

function log(event: string, detail: Record<string, unknown> = {}): void {
  console.debug('[legato tape]', event, detail)
}

export type TapePlayerHost<K> = {
  after(key: K): TapeTrack<K> | null
  /** The playhead is in this track now, fed at `rung`. */
  onTrackPlaying(key: K, landed: boolean, rung: TapeRung | null): void
  onTrackFailed(key: K, error: unknown, starting: boolean): void
}

export class TapePlayer<K> {
  private tape: Tape<K> | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private objectUrl: string | null = null
  // What each track was fed at, for the connection indicator.
  private readonly rungs = new Map<K, TapeRung>()
  private readonly audio: HTMLAudioElement
  private readonly host: TapePlayerHost<K>

  constructor(audio: HTMLAudioElement, host: TapePlayerHost<K>) {
    this.audio = audio
    this.host = host
  }

  /** Plays `track` from `offsetS` in. The first call attaches the
   * MediaSource, so make it where play() may start playback: inside the
   * tap, before any await, on iOS. */
  play(track: TapeTrack<K>, offsetS = 0): void {
    // A stream that has ended isn't taken up again: the next queue gets a
    // MediaSource of its own. In WebKit, a new queue in another codec on
    // the old one (opened again, then changeType) left the element's clock
    // standing still with 20 s buffered.
    if (this.tape?.ended) this.detach()
    this.tape ??= this.attach()
    this.tape.play(track, offsetS)
  }

  seek(offsetS: number): void {
    this.tape?.seek(offsetS)
  }

  /** The track at the playhead and how far into it, in seconds. */
  current(): { key: K; positionS: number } | null {
    return this.tape?.current() ?? null
  }

  queueChanged(): void {
    this.tape?.queueChanged()
  }

  /** Takes the MediaSource down and leaves the element empty. */
  stop(): void {
    if (!this.tape) return
    this.detach()
    this.audio.pause()
    this.audio.srcObject = null
    this.audio.removeAttribute('src')
    this.audio.load()
  }

  private detach(): void {
    this.tape?.destroy()
    this.tape = null
    if (this.heartbeat !== null) clearInterval(this.heartbeat)
    this.heartbeat = null
    for (const event of WAKE_EVENTS) window.removeEventListener(event, this.wake)
    this.rungs.clear()
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl)
    this.objectUrl = null
  }

  private wake = () => this.tape?.pump('server-answered')

  private attach(): Tape<K> {
    const Source = managedMediaSource() ?? (window.MediaSource as MediaSourceClass)
    const mediaSource = new Source()
    // iOS opens a ManagedMediaSource only for an element with remote
    // playback off, or with an AirPlay alternative source. Off, for now:
    // AirPlay from the web player is #416.
    this.audio.disableRemotePlayback = true
    try {
      this.audio.srcObject = mediaSource
    } catch {
      // A browser that takes a MediaSource only by URL (the headless
      // checks, with MediaSource standing in for ManagedMediaSource).
      this.objectUrl = URL.createObjectURL(mediaSource)
      this.audio.src = this.objectUrl
    }

    const deps: FeedDeps = {
      fetch: (input, init) => fetch(input, init),
      isTypeSupported: (type) => Source.isTypeSupported(type),
      retryAfter,
      serverTrouble: serverTroubleNow,
    }
    const tape = new Tape<K>(this.audio, mediaSource as unknown as MediaSourceLike, {
      after: (key) => this.host.after(key),
      open: async (track, fromS, signal) => {
        const feed = await openTrackFeed({ fileId: track.fileId, rung: nextTapeRung(), fromS, signal }, deps)
        this.rungs.set(track.key, feed.rung)
        return feed
      },
      onTrackPlaying: (key, landed) => this.host.onTrackPlaying(key, landed, this.rungs.get(key) ?? null),
      onTrackFailed: (key, error, starting) => this.host.onTrackFailed(key, error, starting),
      log,
    })
    this.heartbeat = setInterval(() => tape.pump('heartbeat'), HEARTBEAT_MS)
    for (const event of WAKE_EVENTS) window.addEventListener(event, this.wake)
    return tape
  }
}
