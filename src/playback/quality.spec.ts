import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  chooseQuality,
  EARLY_END_MS,
  noteDrop,
  prefersAac,
  readQualityPreference,
  STALL_LIMIT_MS,
  storeQualityPreference,
  streamUrl,
  watchForDrops,
} from './quality'
import { announceServerBack, noteOutage, SERVER_BACK_EVENT } from '../connect/reconnect'
import { storeSession } from '../auth/session'

function memoryStorage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, value),
  }
}

const SAFARI_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36'
const CHROME_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0 Mobile/15E148 Safari/604.1'
const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0'

describe('chooseQuality', () => {
  it("uses #120's default per path: original at home, Opus 160 on the relay, Opus 256 on a custom endpoint", () => {
    const base = { preference: 'auto', drops: 0, aac: false } as const
    expect(chooseQuality({ ...base, path: 'home' })).toBe('original')
    expect(chooseQuality({ ...base, path: 'relay' })).toBe('opus160')
    expect(chooseQuality({ ...base, path: 'custom' })).toBe('opus256')
  })

  it('swaps Opus for AAC at the same rung when the browser needs AAC', () => {
    const base = { preference: 'auto', drops: 0, aac: true } as const
    expect(chooseQuality({ ...base, path: 'relay' })).toBe('aac160')
    expect(chooseQuality({ ...base, path: 'custom' })).toBe('aac256')
    expect(chooseQuality({ ...base, path: 'home' })).toBe('original')
  })

  it("lets the user's pick win over the path's default", () => {
    expect(chooseQuality({ path: 'relay', preference: 'original', drops: 0, aac: false })).toBe('original')
    expect(chooseQuality({ path: 'home', preference: 'low', drops: 0, aac: false })).toBe('opus96')
  })

  it('moves down one rung per drop and stops at the bottom', () => {
    const at = (drops: number) => chooseQuality({ path: 'home', preference: 'auto', drops, aac: false })
    expect([0, 1, 2, 3, 4, 9].map(at)).toEqual(['original', 'opus256', 'opus160', 'opus96', 'opus96', 'opus96'])
  })

  it('bottoms out at AAC 160 for an AAC browser, since the server has no AAC 96', () => {
    expect(chooseQuality({ path: 'relay', preference: 'auto', drops: 5, aac: true })).toBe('aac160')
  })
})

describe('prefersAac', () => {
  it('picks AAC for Safari and for every iOS browser', () => {
    expect(prefersAac({ userAgent: SAFARI_MAC, maxTouchPoints: 0, canPlayOpus: true })).toBe(true)
    expect(prefersAac({ userAgent: CHROME_IOS, maxTouchPoints: 5, canPlayOpus: true })).toBe(true)
    // iPadOS asks for the desktop site and says "Macintosh"; touch gives it away.
    expect(prefersAac({ userAgent: SAFARI_MAC, maxTouchPoints: 5, canPlayOpus: true })).toBe(true)
  })

  it('keeps Opus for Chrome and Firefox', () => {
    expect(prefersAac({ userAgent: CHROME_MAC, maxTouchPoints: 0, canPlayOpus: true })).toBe(false)
    expect(prefersAac({ userAgent: FIREFOX_LINUX, maxTouchPoints: 0, canPlayOpus: true })).toBe(false)
  })

  it("picks AAC for any browser that says it can't play Ogg Opus", () => {
    expect(prefersAac({ userAgent: CHROME_MAC, maxTouchPoints: 0, canPlayOpus: false })).toBe(true)
  })
})

describe('quality preference', () => {
  it("defaults to auto, and ignores a stored value it doesn't recognise", () => {
    const storage = memoryStorage()
    expect(readQualityPreference(storage)).toBe('auto')
    storage.setItem('legato:stream-quality', 'lossless-ultra')
    expect(readQualityPreference(storage)).toBe('auto')
  })

  it('round-trips a pick', () => {
    const storage = memoryStorage()
    storeQualityPreference('standard', storage)
    expect(readQualityPreference(storage)).toBe('standard')
  })
})

// Enough of an <audio> element for watchForDrops: real events, settable
// state.
class FakeAudio extends EventTarget {
  error: { code: number } | null = null
  paused = false
  seeking = false
  currentTime = 0
  src = 'http://server/api/v1/files/1/stream?quality=opus160'
  pause = vi.fn(() => {
    this.paused = true
    this.dispatchEvent(new Event('pause'))
  })
  fire(type: string) {
    this.dispatchEvent(new Event(type))
  }
}

describe('watchForDrops', () => {
  let storage: Storage

  beforeEach(() => {
    vi.useFakeTimers()
    storage = memoryStorage()
    vi.stubGlobal('localStorage', storage)
    // streamUrl -> withMediaTicket resolves the server origin against the page.
    vi.stubGlobal('window', { location: { href: 'http://127.0.0.1:5184/' } })
    storeQualityPreference('auto', storage) // also resets the session's drop count
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  // streamUrl's chosen rung, read back out of the URL it builds.
  const nextQuality = () => new URL(streamUrl(7)).searchParams.get('quality')

  // Lets the health check an early end or a failed load asks for answer.
  const settle = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  }
  const serverUp = () => Promise.resolve(true)
  const serverDown = () => Promise.resolve(false)

  it('on a network error mid-track: pauses, reports it, and moves the next track down a rung', () => {
    const audio = new FakeAudio()
    const onDrop = vi.fn()
    watchForDrops(audio, onDrop, { online: null })
    expect(nextQuality()).toBe('original')

    audio.currentTime = 42
    audio.error = { code: 2 }
    audio.fire('error')

    expect(audio.pause).toHaveBeenCalled()
    expect(onDrop).toHaveBeenCalledTimes(1)
    expect(nextQuality()).toBe('opus256')
  })

  it('reloads the same source at the same spot, so pressing play resumes it', () => {
    const audio = new FakeAudio()
    const src = audio.src
    let assigned: string | null = null
    Object.defineProperty(audio, 'src', {
      get: () => assigned ?? src,
      set: (value: string) => {
        assigned = value
        audio.currentTime = 0
      },
    })
    watchForDrops(audio, () => undefined, { online: null })

    audio.currentTime = 42
    audio.error = { code: 2 }
    audio.fire('error')

    expect(assigned).toBe(src)
    expect(audio.currentTime).toBe(42)
  })

  it("doesn't count the reload failing again (still offline) as a second drop, and retries once back online", () => {
    const audio = new FakeAudio()
    const online = new EventTarget()
    const onDrop = vi.fn()
    watchForDrops(audio, onDrop, { online })

    audio.currentTime = 42
    audio.error = { code: 2 }
    audio.fire('error')
    audio.currentTime = 42
    audio.fire('error')
    expect(onDrop).toHaveBeenCalledTimes(1)
    expect(nextQuality()).toBe('opus256')

    const reloads: string[] = []
    Object.defineProperty(audio, 'src', {
      get: () => 'http://server/api/v1/files/1/stream?quality=opus160',
      set: (value: string) => reloads.push(value),
    })
    online.dispatchEvent(new Event('online'))
    expect(reloads).toHaveLength(1)
  })

  // #119: the server answering again is the other "back online".
  it('reloads a dropped track at the spot it stopped once the server is back, though failed reloads reset the clock', () => {
    const audio = new FakeAudio()
    const online = new EventTarget()
    const src = audio.src
    const assigned: string[] = []
    Object.defineProperty(audio, 'src', {
      get: () => assigned.at(-1) ?? src,
      set: (value: string) => {
        assigned.push(value)
        // A real element starts a new load from 0.
        audio.currentTime = 0
      },
    })
    const onDrop = vi.fn()
    watchForDrops(audio, onDrop, { online })

    audio.currentTime = 83
    audio.error = { code: 2 }
    audio.fire('error')
    // The reload fails too, the server still gone, and its clock is 0 now.
    audio.currentTime = 0
    audio.fire('error')

    online.dispatchEvent(new Event(SERVER_BACK_EVENT))

    expect(onDrop).toHaveBeenCalledTimes(1)
    expect(assigned).toEqual([src, src])
    expect(audio.currentTime).toBe(83)
  })

  it('once the server is back, loads a track that failed to start while it was gone', async () => {
    const audio = new FakeAudio()
    const online = new EventTarget()
    const reloads: string[] = []
    watchForDrops(audio, () => undefined, { online, serverAnswers: serverDown })
    Object.defineProperty(audio, 'src', {
      get: () => 'http://server/api/v1/files/2/stream?quality=original',
      set: (value: string) => reloads.push(value),
    })

    // A load that fails before any of it arrives reports "not supported".
    audio.error = { code: 4 }
    audio.fire('error')
    await settle()
    online.dispatchEvent(new Event(SERVER_BACK_EVENT))

    expect(reloads).toEqual(['http://server/api/v1/files/2/stream?quality=original'])
    expect(audio.currentTime).toBe(0)
  })

  // The coordinator's review of #346: a missing file looks the same to the
  // element, and was asked for again on every reconnect.
  it("leaves a track that won't load while the server answers alone, however often it comes back", async () => {
    const audio = new FakeAudio()
    const online = new EventTarget()
    const reloads: string[] = []
    watchForDrops(audio, () => undefined, { online, serverAnswers: serverUp })
    Object.defineProperty(audio, 'src', {
      get: () => 'http://server/api/v1/files/2/stream?quality=original',
      set: (value: string) => reloads.push(value),
    })

    audio.error = { code: 4 }
    audio.fire('error')
    await settle()
    online.dispatchEvent(new Event(SERVER_BACK_EVENT))
    online.dispatchEvent(new Event('online'))
    online.dispatchEvent(new Event(SERVER_BACK_EVENT))

    expect(reloads).toEqual([])
  })

  it('loads a dropped track again with the media ticket the session has now', async () => {
    storeSession({ token: 'session', mediaTicket: 'before' }, storage)
    const audio = new FakeAudio()
    audio.src = `http://server/api/v1/files/1/stream?quality=original&t=before`
    const online = new EventTarget()
    watchForDrops(audio, () => undefined, { online })

    audio.currentTime = 42
    audio.error = { code: 2 }
    audio.fire('error')
    expect(new URL(audio.src).searchParams.get('t')).toBe('before')

    // Renewed while the server was gone.
    storeSession({ token: 'session', mediaTicket: 'after' }, storage)
    online.dispatchEvent(new Event(SERVER_BACK_EVENT))

    const url = new URL(audio.src)
    expect(url.searchParams.getAll('t')).toEqual(['after'])
    expect(url.searchParams.get('quality')).toBe('original')
    expect(audio.currentTime).toBe(42)
  })

  it("waits for the server and the session during an outage, rather than loading again on the browser's online", async () => {
    const page = Object.assign(new EventTarget(), { location: { href: 'http://127.0.0.1:5184/' } })
    vi.stubGlobal('window', page)
    const audio = new FakeAudio()
    const reloads: string[] = []
    watchForDrops(audio, () => undefined, { online: page })
    audio.currentTime = 42
    audio.error = { code: 2 }
    audio.fire('error')
    Object.defineProperty(audio, 'src', {
      get: () => 'http://server/api/v1/files/1/stream?quality=opus160',
      set: (value: string) => reloads.push(value),
    })

    noteOutage()
    page.dispatchEvent(new Event('online'))
    expect(reloads).toHaveLength(0)

    await announceServerBack(0)
    expect(reloads).toHaveLength(1)
  })

  it("treats an end well short of the track's length as a drop when the server doesn't answer, and passes a real end on", async () => {
    const audio = new FakeAudio()
    const onDrop = vi.fn()
    const onEnded = vi.fn()
    const serverAnswers = vi.fn(serverDown)
    watchForDrops(audio, onDrop, { online: null, onEnded, durationMs: () => 180_000, serverAnswers })

    audio.currentTime = 57.6
    audio.fire('ended')
    await settle()
    expect(serverAnswers).toHaveBeenCalledTimes(1)
    expect(onDrop).toHaveBeenCalledTimes(1)
    expect(onEnded).not.toHaveBeenCalled()
    expect(audio.currentTime).toBe(57.6)
    expect(nextQuality()).toBe('opus256')

    audio.currentTime = 180 - EARLY_END_MS / 1000 + 0.5
    audio.fire('ended')
    await settle()
    expect(onEnded).toHaveBeenCalledTimes(1)
    expect(onDrop).toHaveBeenCalledTimes(1)
    expect(serverAnswers).toHaveBeenCalledTimes(1)
  })

  // The coordinator's review of #346: a VBR MP3 with no Xing header, or a
  // truncated file, has a stored length longer than its audio.
  it('lets a file whose stored length is 14 s longer than its audio end and move on, without stepping the ladder down', async () => {
    const audio = new FakeAudio()
    const onDrop = vi.fn()
    const onEnded = vi.fn()
    watchForDrops(audio, onDrop, { online: null, onEnded, durationMs: () => 194_000, serverAnswers: serverUp })

    audio.currentTime = 180
    audio.fire('ended')
    await settle()

    expect(onEnded).toHaveBeenCalledTimes(1)
    expect(onDrop).not.toHaveBeenCalled()
    expect(audio.pause).not.toHaveBeenCalled()
    expect(nextQuality()).toBe('original')
  })

  it('takes an early end after the element said its data stopped coming as a drop, without asking the server', async () => {
    const audio = new FakeAudio()
    const onDrop = vi.fn()
    const serverAnswers = vi.fn(serverUp)
    watchForDrops(audio, onDrop, { online: null, durationMs: () => 180_000, serverAnswers })

    audio.currentTime = 50
    audio.fire('stalled')
    audio.currentTime = 58
    audio.fire('ended')
    await settle()

    expect(serverAnswers).not.toHaveBeenCalled()
    expect(onDrop).toHaveBeenCalledTimes(1)
  })

  it('forgets a stall the stream recovered from', async () => {
    const audio = new FakeAudio()
    const onDrop = vi.fn()
    const onEnded = vi.fn()
    watchForDrops(audio, onDrop, { online: null, onEnded, durationMs: () => 194_000, serverAnswers: serverUp })

    audio.fire('stalled')
    audio.fire('progress')
    audio.currentTime = 180
    audio.fire('ended')
    await settle()

    expect(onDrop).not.toHaveBeenCalled()
    expect(onEnded).toHaveBeenCalledTimes(1)
  })

  it('leaves an early end alone if the track moved on while the server was asked', async () => {
    const audio = new FakeAudio()
    const onDrop = vi.fn()
    const onEnded = vi.fn()
    watchForDrops(audio, onDrop, { online: null, onEnded, durationMs: () => 180_000, serverAnswers: serverDown })

    audio.currentTime = 58
    audio.fire('ended')
    audio.src = 'http://server/api/v1/files/2/stream?quality=original'
    await settle()

    expect(onDrop).not.toHaveBeenCalled()
    expect(onEnded).not.toHaveBeenCalled()
  })

  it('passes every end on when the length is unknown', () => {
    const audio = new FakeAudio()
    const onEnded = vi.fn()
    watchForDrops(audio, () => undefined, { online: null, onEnded })

    audio.currentTime = 12
    audio.fire('ended')
    expect(onEnded).toHaveBeenCalledTimes(1)
  })

  it("leaves a decode error alone when the server comes back, and does nothing when nothing failed", () => {
    const audio = new FakeAudio()
    const online = new EventTarget()
    const reloads: string[] = []
    watchForDrops(audio, () => undefined, { online })
    Object.defineProperty(audio, 'src', {
      get: () => 'http://server/api/v1/files/1/stream?quality=original',
      set: (value: string) => reloads.push(value),
    })

    online.dispatchEvent(new Event(SERVER_BACK_EVENT))
    audio.error = { code: 3 } // MEDIA_ERR_DECODE
    online.dispatchEvent(new Event(SERVER_BACK_EVENT))

    expect(reloads).toEqual([])
  })

  it('ignores errors that are not network errors, and a track that never started', () => {
    const audio = new FakeAudio()
    const onDrop = vi.fn()
    watchForDrops(audio, onDrop, { online: null })

    audio.currentTime = 10
    audio.error = { code: 3 } // MEDIA_ERR_DECODE
    audio.fire('error')
    audio.currentTime = 0
    audio.error = { code: 2 }
    audio.fire('error')

    expect(onDrop).not.toHaveBeenCalled()
  })

  it('treats buffering past the stall limit mid-track as a drop, but not a stall that recovers', () => {
    const audio = new FakeAudio()
    const onDrop = vi.fn()
    watchForDrops(audio, onDrop, { online: null })
    audio.currentTime = 30

    audio.fire('waiting')
    vi.advanceTimersByTime(STALL_LIMIT_MS - 1)
    audio.fire('playing')
    vi.advanceTimersByTime(STALL_LIMIT_MS)
    expect(onDrop).not.toHaveBeenCalled()

    audio.fire('waiting')
    vi.advanceTimersByTime(STALL_LIMIT_MS)
    expect(onDrop).toHaveBeenCalledTimes(1)
    expect(audio.pause).toHaveBeenCalled()
  })

  it("doesn't time a wait that's part of a seek", () => {
    const audio = new FakeAudio()
    const onDrop = vi.fn()
    watchForDrops(audio, onDrop, { online: null })
    audio.currentTime = 30
    audio.seeking = true

    audio.fire('waiting')
    vi.advanceTimersByTime(STALL_LIMIT_MS * 2)
    expect(onDrop).not.toHaveBeenCalled()
  })

  it('stops listening after cleanup', () => {
    const audio = new FakeAudio()
    const onDrop = vi.fn()
    watchForDrops(audio, onDrop, { online: null })()

    audio.currentTime = 42
    audio.error = { code: 2 }
    audio.fire('error')
    expect(onDrop).not.toHaveBeenCalled()
  })

  it('a new pick in settings starts the ladder over', () => {
    noteDrop()
    noteDrop()
    expect(nextQuality()).toBe('opus160')
    storeQualityPreference('auto', storage)
    expect(nextQuality()).toBe('original')
  })
})
