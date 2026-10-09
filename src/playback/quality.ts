import { API_BASE as API } from '../config/serverHost'
import { withMediaTicket } from '../auth/session'
import { SERVER_BACK_EVENT } from '../connect/reconnect'

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
// counts as the stream being cut (#119) rather than the track finishing. A
// transcode's length differs from the file's by well under a second.
export const EARLY_END_MS = 5000

type MediaLike = Pick<HTMLMediaElement, 'addEventListener' | 'removeEventListener' | 'pause'> & {
  readonly error: { code: number } | null
  readonly paused: boolean
  readonly seeking: boolean
  currentTime: number
  src: string
}

/** Watches the web player for a mid-track drop: a network error, or a stall
 * longer than STALL_LIMIT_MS. On one it pauses the track, steps the ladder
 * down for the next, and calls `onDrop` so the UI can show paused.
 *
 * A network error leaves the element dead, so play() on it would fail. The
 * same source is reloaded paused at the same position, so pressing play
 * picks up where it stopped. A reload that fails too (still offline) isn't
 * a second drop. It's retried when the browser reports it's back online,
 * or when the server answers again after an outage (#119's
 * SERVER_BACK_EVENT, from useServerReady). That retry also revives a track
 * that couldn't start at all while the server was gone.
 *
 * A server that goes away mid-track can also end the stream rather than
 * fail it: the browser plays what arrived and fires `ended`, as though the
 * file stopped there. Short of `durationMs` by more than EARLY_END_MS,
 * that's a drop too. Only a real end reaches `onEnded`.
 *
 * Returns a cleanup function. */
export function watchForDrops(
  audio: MediaLike,
  onDrop: () => void,
  {
    online = typeof window === 'undefined' ? null : window,
    onEnded = () => {},
    durationMs = () => null,
  }: { online?: EventTarget | null; onEnded?: () => void; durationMs?: () => number | null } = {},
): () => void {
  let stallTimer: ReturnType<typeof setTimeout> | null = null
  let reloading: { src: string; at: number } | null = null
  let earlyEnd: { src: string; at: number } | null = null

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

  const reload = () => {
    // A source already reloaded once keeps the position it was reloaded
    // at: a load that failed may have taken currentTime back to 0.
    const at = reloading?.src === audio.src ? reloading.at : audio.currentTime
    reloading = { src: audio.src, at }
    audio.src = reloading.src
    // Set before metadata loads, this becomes the element's default start
    // position, which is where the reloaded track begins.
    audio.currentTime = at
  }

  const onError = () => {
    if (audio.error?.code !== MEDIA_ERR_NETWORK) return
    if (reloading !== null && audio.src === reloading.src) return
    // A track that never started didn't drop mid-track. usePlayback's own
    // play() rejection already shows it as not playing.
    if (audio.currentTime <= 0) return
    drop()
    reload()
  }

  const onWaiting = () => {
    if (audio.paused || audio.seeking || audio.currentTime <= 0) return
    clearStall()
    stallTimer = setTimeout(drop, STALL_LIMIT_MS)
  }

  const onLoaded = () => {
    reloading = null
  }

  // A second early end at the same spot is the track's real end: the
  // database's length was wrong, and holding it there would stick.
  const onEnd = () => {
    const expected = durationMs()
    const at = audio.currentTime
    const again = earlyEnd?.src === audio.src && Math.abs(earlyEnd.at - at) < 2
    if (expected != null && at * 1000 < expected - EARLY_END_MS && !again) {
      earlyEnd = { src: audio.src, at }
      drop()
      reload()
      return
    }
    earlyEnd = null
    onEnded()
  }

  // Whatever the outage killed loads again where it stopped, paused: a
  // dropped track whose reload failed too, or one that failed before it
  // could start. A decode error isn't the network's, so it stays as it is.
  const onBack = () => {
    const code = audio.error?.code
    if (!audio.src || (code !== MEDIA_ERR_NETWORK && code !== MEDIA_ERR_SRC_NOT_SUPPORTED)) return
    reload()
  }

  const settled = ['playing', 'pause', 'seeking', 'emptied', 'ended'] as const
  audio.addEventListener('error', onError)
  audio.addEventListener('waiting', onWaiting)
  audio.addEventListener('loadeddata', onLoaded)
  audio.addEventListener('ended', onEnd)
  for (const event of settled) audio.addEventListener(event, clearStall)
  online?.addEventListener('online', onBack)
  online?.addEventListener(SERVER_BACK_EVENT, onBack)

  return () => {
    clearStall()
    audio.removeEventListener('error', onError)
    audio.removeEventListener('waiting', onWaiting)
    audio.removeEventListener('loadeddata', onLoaded)
    audio.removeEventListener('ended', onEnd)
    for (const event of settled) audio.removeEventListener(event, clearStall)
    online?.removeEventListener('online', onBack)
    online?.removeEventListener(SERVER_BACK_EVENT, onBack)
  }
}
