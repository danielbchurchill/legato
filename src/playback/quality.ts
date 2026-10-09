import { API_BASE as API } from '../config/serverHost'
import { withMediaTicket } from '../auth/session'
import { inOutage, SERVER_BACK_EVENT } from '../connect/reconnect'
import { HEALTH_TIMEOUT_MS } from '../connect/unreachable'

/* Issue #120: which rung of the server's quality ladder a browser
 * client asks GET /files/:id/stream for. Only the web <audio> path uses
 * this. Native desktop playback reads files straight off disk and never
 * asks the server to transcode anything.
 *
 * Chosen once per track, when its URL is built: a drop part-way through a
 * track pauses that track and moves the *next* one down a rung. There's no
 * HLS or other mid-track switching (#120). */

export type StreamQuality = 'original' | 'opus96' | 'opus160' | 'opus256' | 'aac160' | 'aac256'
export type ConnectionPath = 'home' | 'relay' | 'custom'

/** Codec-neutral rungs, best first. Which codec a rung means depends on
 * the browser (rungQuality below). */
const LADDER = ['original', 'high', 'standard', 'low'] as const
type Rung = (typeof LADDER)[number]

/** What the user picked in settings. 'auto' follows the connection path. */
export type QualityPreference = 'auto' | Rung

export const QUALITY_PREFERENCES: readonly QualityPreference[] = ['auto', ...LADDER]

// Issue #120's default rung for each connection path.
const DEFAULT_RUNG: Record<ConnectionPath, Rung> = {
  home: 'original',
  relay: 'standard',
  custom: 'high',
}

/** How this client reaches its server. It always says 'home' for now.
 * Nothing yet knows the real answer: the connection-path indicator is
 * #118's, and #118 replaces this function's body when it lands. 'home'
 * keeps today's behaviour (full-quality audio) until then. */
export function connectionPath(): ConnectionPath {
  return 'home'
}

type BrowserTraits = { userAgent: string; maxTouchPoints: number; canPlayOpus: boolean }

/** Safari and every iOS browser (all WebKit underneath) get AAC in place of
 * Opus (#120). Safari's Opus support has come and gone
 * across versions, so a browser that says it can't play Ogg Opus gets AAC
 * as well, whatever its user agent claims. */
export function prefersAac({ userAgent, maxTouchPoints, canPlayOpus }: BrowserTraits): boolean {
  const ios = /iPad|iPhone|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1)
  const safari = /Safari\//.test(userAgent) && !/Chrome\/|Chromium\/|CriOS\/|Edg\/|Firefox\/|FxiOS\//.test(userAgent)
  return ios || safari || !canPlayOpus
}

function rungQuality(rung: Rung, aac: boolean): StreamQuality {
  switch (rung) {
    case 'original':
      return 'original'
    case 'high':
      return aac ? 'aac256' : 'opus256'
    case 'standard':
      return aac ? 'aac160' : 'opus160'
    case 'low':
      // There's no AAC 96 on the server's ladder; AAC 160 is the floor.
      return aac ? 'aac160' : 'opus96'
  }
}

/** The rung for the next track: the user's pick, or the path's default,
 * moved down once per drop so far and stopping at the bottom. */
export function chooseQuality({
  path,
  preference,
  drops,
  aac,
}: {
  path: ConnectionPath
  preference: QualityPreference
  drops: number
  aac: boolean
}): StreamQuality {
  const start = preference === 'auto' ? DEFAULT_RUNG[path] : preference
  const index = Math.min(LADDER.indexOf(start) + drops, LADDER.length - 1)
  return rungQuality(LADDER[index], aac)
}

// Per device, not per account (the settings table is per account): a phone
// on the relay and a desktop on the home network want different answers
// from the same library. Same reasoning as useTheme.ts.
const PREFERENCE_KEY = 'legato:stream-quality'

function defaultStorage(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage
}

export function readQualityPreference(storage: Storage | null = defaultStorage()): QualityPreference {
  const stored = storage?.getItem(PREFERENCE_KEY)
  return QUALITY_PREFERENCES.find((p) => p === stored) ?? 'auto'
}

export function storeQualityPreference(preference: QualityPreference, storage: Storage | null = defaultStorage()): void {
  storage?.setItem(PREFERENCE_KEY, preference)
  // A new pick is a fresh start: the rungs already given up were given up
  // under the old one.
  dropsThisSession = 0
}

// Rungs given up so far in this tab. It never climbs back up on its own:
// nothing here can tell a network that has recovered from one that is
// about to drop again. Reloading the tab or changing the setting resets it.
let dropsThisSession = 0

export function noteDrop(): void {
  dropsThisSession += 1
}

function currentBrowser(): BrowserTraits {
  if (typeof navigator === 'undefined') return { userAgent: '', maxTouchPoints: 0, canPlayOpus: true }
  const probe = typeof Audio === 'undefined' ? null : new Audio()
  return {
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    canPlayOpus: probe ? probe.canPlayType('audio/ogg; codecs="opus"') !== '' : true,
  }
}

let aacForThisBrowser: boolean | null = null

/** The URL the web player loads for a file. The single place #120's
 * quality choice reaches usePlayback. */
export function streamUrl(fileId: number): string {
  aacForThisBrowser ??= prefersAac(currentBrowser())
  const quality = chooseQuality({
    path: connectionPath(),
    preference: readQualityPreference(),
    drops: dropsThisSession,
    aac: aacForThisBrowser,
  })
  return withMediaTicket(`${API}/files/${fileId}/stream?quality=${quality}`)
}

// HTMLMediaElement's MEDIA_ERR_NETWORK and MEDIA_ERR_SRC_NOT_SUPPORTED.
// Literals, because MediaError isn't defined outside a browser and the
// specs run in Node. A source that fails before any of it loads (the
// server already gone) reports the second.
const MEDIA_ERR_NETWORK = 2
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4

// How long playback can sit buffering, mid-track and not seeking, before
// it counts as a drop. Long enough that a slow seek into an encode still
// under way on the server doesn't trip it.
export const STALL_LIMIT_MS = 20_000

// How far short of a track's known length an `ended` has to come before it
// could be the stream being cut (#119) rather than the track finishing. A
// transcode's length differs from the file's by well under a second.
export const EARLY_END_MS = 5000

type MediaLike = Pick<HTMLMediaElement, 'addEventListener' | 'removeEventListener' | 'pause'> & {
  readonly error: { code: number } | null
  readonly paused: boolean
  readonly seeking: boolean
  currentTime: number
  src: string
}

/** Whether the server answers its health check right now. */
function serverAnswersNow(): Promise<boolean> {
  return fetch(`${API}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) }).then(
    (res) => res.ok,
    () => false,
  )
}

// A stream URL without its media ticket: the same stream, whichever ticket
// it was asked for with.
function streamOf(src: string): string {
  if (!src) return ''
  try {
    const url = new URL(src)
    url.searchParams.delete('t')
    return url.href
  } catch {
    return src
  }
}

/** Watches the web player for a mid-track drop: a network error, or a stall
 * longer than STALL_LIMIT_MS. On one it pauses the track, steps the ladder
 * down for the next, and calls `onDrop` so the UI can show paused.
 *
 * A network error leaves the element dead, so play() on it would fail. The
 * same source is reloaded paused at the same position, so pressing play
 * picks up where it stopped. A reload that fails too (still offline) isn't
 * a second drop. It's loaded again once the server is back after an outage
 * (#119's SERVER_BACK_EVENT, which waits for the session to be renewed), or
 * when the browser comes back online from a drop too short to be one. That
 * also revives a track that couldn't start at all while the server was gone.
 * Only a failure that was the network's is loaded again, always with the
 * current media ticket: a track that won't load while the server answers
 * (a missing file, which looks the same to the element) is left alone.
 *
 * A server that goes away mid-track can also end the stream rather than
 * fail it: the browser plays what arrived and fires `ended`, as though the
 * file stopped there. So can a file whose length on record is wrong. An end
 * short of `durationMs` by more than EARLY_END_MS is a drop only with
 * evidence the network failed: a stall on the way there, or a server that
 * doesn't answer now. Otherwise it's the track's end, and `onEnded` gets it.
 *
 * Returns a cleanup function. */
export function watchForDrops(
  audio: MediaLike,
  onDrop: () => void,
  {
    online = typeof window === 'undefined' ? null : window,
    onEnded = () => {},
    durationMs = () => null,
    serverAnswers = serverAnswersNow,
  }: {
    online?: EventTarget | null
    onEnded?: () => void
    durationMs?: () => number | null
    serverAnswers?: () => Promise<boolean>
  } = {},
): () => void {
  let stallTimer: ReturnType<typeof setTimeout> | null = null
  // A stream that failed because the network did, and where to pick it up.
  let retry: { stream: string; at: number } | null = null
  // The element said its data stopped coming, and nothing has come since.
  let stalled = false

  const clearStall = () => {
    if (stallTimer !== null) clearTimeout(stallTimer)
    stallTimer = null
  }

  const drop = () => {
    clearStall()
    noteDrop()
    audio.pause()
    onDrop()
  }

  const failedHere = () => retry !== null && retry.stream === streamOf(audio.src)

  // Remembers where to pick the stream up. A stream already waiting keeps
  // the spot it had: a load that failed may have taken currentTime to 0.
  const markForRetry = (at: number) => {
    if (!failedHere()) retry = { stream: streamOf(audio.src), at }
  }

  const reload = () => {
    if (!retry || !failedHere()) return
    audio.src = withMediaTicket(retry.stream)
    // Set before metadata loads, this becomes the element's default start
    // position, which is where the reloaded track begins.
    audio.currentTime = retry.at
  }

  const onError = () => {
    const code = audio.error?.code
    if (code !== MEDIA_ERR_NETWORK && code !== MEDIA_ERR_SRC_NOT_SUPPORTED) return
    // A reload that failed too, the server still gone: not a second drop.
    if (failedHere()) return
    if (code === MEDIA_ERR_NETWORK && audio.currentTime > 0) {
      markForRetry(audio.currentTime)
      drop()
      reload()
      return
    }
    // A track that couldn't load at all didn't drop mid-track, and
    // usePlayback's own play() rejection already shows it as not playing.
    // It's worth loading again only if the server was out of reach.
    const src = audio.src
    void serverAnswers().then((answers) => {
      if (!answers && audio.src === src) markForRetry(0)
    })
  }

  const onWaiting = () => {
    if (audio.paused || audio.seeking || audio.currentTime <= 0) return
    clearStall()
    stallTimer = setTimeout(drop, STALL_LIMIT_MS)
  }

  const onStalled = () => {
    stalled = true
  }

  const onProgress = () => {
    stalled = false
  }

  const onLoaded = () => {
    stalled = false
    if (failedHere()) retry = null
  }

  const onEnd = () => {
    const expected = durationMs()
    const at = audio.currentTime
    if (expected == null || at * 1000 >= expected - EARLY_END_MS) {
      onEnded()
      return
    }
    const src = audio.src
    const answers = stalled ? Promise.resolve(false) : serverAnswers()
    void answers.then((up) => {
      // Moved on meanwhile (next, or a new queue): that's its own answer.
      if (audio.src !== src) return
      if (up) {
        onEnded()
        return
      }
      markForRetry(at)
      drop()
      reload()
    })
  }

  const onServerBack = () => reload()
  // The browser back online: a drop too short to be an outage loads again
  // now. During one, it waits for SERVER_BACK_EVENT and the session.
  const onOnline = () => {
    if (!inOutage()) reload()
  }

  const settled = ['playing', 'pause', 'seeking', 'emptied', 'ended'] as const
  audio.addEventListener('error', onError)
  audio.addEventListener('waiting', onWaiting)
  audio.addEventListener('stalled', onStalled)
  audio.addEventListener('progress', onProgress)
  audio.addEventListener('loadeddata', onLoaded)
  audio.addEventListener('ended', onEnd)
  for (const event of settled) audio.addEventListener(event, clearStall)
  online?.addEventListener('online', onOnline)
  online?.addEventListener(SERVER_BACK_EVENT, onServerBack)

  return () => {
    clearStall()
    audio.removeEventListener('error', onError)
    audio.removeEventListener('waiting', onWaiting)
    audio.removeEventListener('stalled', onStalled)
    audio.removeEventListener('progress', onProgress)
    audio.removeEventListener('loadeddata', onLoaded)
    audio.removeEventListener('ended', onEnd)
    for (const event of settled) audio.removeEventListener(event, clearStall)
    online?.removeEventListener('online', onOnline)
    online?.removeEventListener(SERVER_BACK_EVENT, onServerBack)
  }
}
