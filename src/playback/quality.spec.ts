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
import { SERVER_BACK_EVENT } from '../connect/unreachable'

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

  it('once the server is back, loads a track that failed to start while it was gone', () => {
    const audio = new FakeAudio()
    const online = new EventTarget()
    const reloads: string[] = []
    watchForDrops(audio, () => undefined, { online })
    Object.defineProperty(audio, 'src', {
      get: () => 'http://server/api/v1/files/2/stream?quality=original',
      set: (value: string) => reloads.push(value),
    })

    // A load that fails before any of it arrives reports "not supported".
    audio.error = { code: 4 }
    audio.fire('error')
    online.dispatchEvent(new Event(SERVER_BACK_EVENT))

    expect(reloads).toEqual(['http://server/api/v1/files/2/stream?quality=original'])
    expect(audio.currentTime).toBe(0)
  })

  it('treats a track that ends well short of its length as a drop, and passes a real end on', () => {
    const audio = new FakeAudio()
    const onDrop = vi.fn()
    const onEnded = vi.fn()
    watchForDrops(audio, onDrop, { online: null, onEnded, durationMs: () => 180_000 })

    audio.currentTime = 57.6
    audio.fire('ended')
    expect(onDrop).toHaveBeenCalledTimes(1)
    expect(onEnded).not.toHaveBeenCalled()
    expect(audio.currentTime).toBe(57.6)
    expect(nextQuality()).toBe('opus256')

    audio.currentTime = 180 - EARLY_END_MS / 1000 + 0.5
    audio.fire('ended')
    expect(onEnded).toHaveBeenCalledTimes(1)
    expect(onDrop).toHaveBeenCalledTimes(1)
  })

  it('takes a second early end at the same spot as the real end, so a wrong length in the database never sticks', () => {
    const audio = new FakeAudio()
    const onDrop = vi.fn()
    const onEnded = vi.fn()
    watchForDrops(audio, onDrop, { online: null, onEnded, durationMs: () => 240_000 })

    audio.currentTime = 170
    audio.fire('ended')
    audio.currentTime = 170.4
    audio.fire('ended')

    expect(onDrop).toHaveBeenCalledTimes(1)
    expect(onEnded).toHaveBeenCalledTimes(1)
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
