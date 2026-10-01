import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { storeSession } from '../auth/session'
import {
  applyMetadata,
  artworkFor,
  bindMediaSessionActions,
  readArtistAndAlbum,
  syncPositionState,
  type MediaSessionControls,
  type MediaSessionLike,
} from './mediaSession'

function memoryStorage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, value),
  }
}

class FakeSession implements MediaSessionLike {
  metadata: MediaMetadata | null = null
  playbackState: MediaSessionPlaybackState = 'none'
  handlers = new Map<MediaSessionAction, MediaSessionActionHandler>()
  unsupported = new Set<MediaSessionAction>()
  setPositionState = vi.fn()
  setActionHandler(action: MediaSessionAction, handler: MediaSessionActionHandler | null) {
    if (this.unsupported.has(action)) throw new TypeError(`${action} is not a valid MediaSessionAction`)
    if (handler) this.handlers.set(action, handler)
    else this.handlers.delete(action)
  }
  press(action: MediaSessionAction, details: Partial<MediaSessionActionDetails> = {}) {
    this.handlers.get(action)?.({ action, ...details } as MediaSessionActionDetails)
  }
}

function fakeControls() {
  return {
    play: vi.fn(),
    pause: vi.fn(),
    next: vi.fn(),
    previous: vi.fn(),
    seek: vi.fn((positionMs: number) => positionMs),
  } satisfies MediaSessionControls
}

describe('bindMediaSessionActions', () => {
  it('routes the lock-screen and headphone buttons to the player', () => {
    const session = new FakeSession()
    const controls = fakeControls()
    bindMediaSessionActions(session, () => controls)

    session.press('play')
    session.press('pause')
    session.press('nexttrack')
    session.press('previoustrack')

    expect(controls.play).toHaveBeenCalledTimes(1)
    expect(controls.pause).toHaveBeenCalledTimes(1)
    expect(controls.next).toHaveBeenCalledTimes(1)
    expect(controls.previous).toHaveBeenCalledTimes(1)
  })

  it('turns a scrubber drag (seconds) into a seek (milliseconds) and reports it', () => {
    const session = new FakeSession()
    const controls = fakeControls()
    const onSeek = vi.fn()
    bindMediaSessionActions(session, () => controls, onSeek)

    session.press('seekto', { seekTime: 42.5 })
    expect(controls.seek).toHaveBeenCalledWith(42500)
    expect(onSeek).toHaveBeenCalledWith(42500)

    session.press('seekto', {})
    expect(controls.seek).toHaveBeenCalledTimes(1)
  })

  it('reads the controls at press time, so a re-rendered player is the one that answers', () => {
    const session = new FakeSession()
    let current = fakeControls()
    const first = current
    bindMediaSessionActions(session, () => current)
    current = fakeControls()

    session.press('pause')
    expect(first.pause).not.toHaveBeenCalled()
    expect(current.pause).toHaveBeenCalledTimes(1)
  })

  it('keeps the other buttons when the browser rejects one it does not know', () => {
    const session = new FakeSession()
    session.unsupported.add('seekto')
    const controls = fakeControls()
    expect(() => bindMediaSessionActions(session, () => controls)).not.toThrow()

    session.press('nexttrack')
    expect(controls.next).toHaveBeenCalledTimes(1)
    expect(session.handlers.has('seekto')).toBe(false)
  })

  it('unhooks every button it set on cleanup', () => {
    const session = new FakeSession()
    const unbind = bindMediaSessionActions(session, () => fakeControls())
    expect([...session.handlers.keys()].sort()).toEqual(['nexttrack', 'pause', 'play', 'previoustrack', 'seekto'])
    unbind()
    expect(session.handlers.size).toBe(0)
  })
})

describe('syncPositionState', () => {
  it('hands the session seconds, clamped inside the track', () => {
    const session = new FakeSession()
    syncPositionState(session, { positionMs: 61_000, durationMs: 180_000 })
    expect(session.setPositionState).toHaveBeenLastCalledWith({ duration: 180, position: 61, playbackRate: 1 })

    syncPositionState(session, { positionMs: 200_000, durationMs: 180_000 })
    expect(session.setPositionState).toHaveBeenLastCalledWith({ duration: 180, position: 180, playbackRate: 1 })
  })

  it('clears the scrubber when the length is unknown, rather than guessing one', () => {
    const session = new FakeSession()
    syncPositionState(session, { positionMs: 5_000, durationMs: null })
    expect(session.setPositionState).toHaveBeenLastCalledWith()
  })

  it('is a no-op on a browser without setPositionState', () => {
    const session = new FakeSession() as MediaSessionLike
    delete session.setPositionState
    expect(() => syncPositionState(session, { positionMs: 0, durationMs: 1000 })).not.toThrow()
  })
})

describe('applyMetadata', () => {
  it('shows the track, then clears it and the state when nothing is current', () => {
    const session = new FakeSession()
    session.playbackState = 'playing'
    const create = vi.fn((init: MediaMetadataInit) => init as unknown as MediaMetadata)

    applyMetadata(session, { title: 'Struggler', artist: 'Genesis Owusu', album: 'Struggler', artwork: [] }, create)
    expect(session.metadata).toMatchObject({ title: 'Struggler', artist: 'Genesis Owusu', album: 'Struggler' })
    expect(session.playbackState).toBe('playing')

    applyMetadata(session, null, create)
    expect(session.metadata).toBeNull()
    expect(session.playbackState).toBe('none')
  })
})

describe('readArtistAndAlbum', () => {
  it("reads a recording's outgoing performed_by and appears_on edges", () => {
    const node = {
      edges: [
        { direction: 'in', type: 'performed_by', other_title: 'not this one' },
        { direction: 'out', type: 'performed_by', other_title: 'Genesis Owusu' },
        { direction: 'out', type: 'appears_on', other_title: 'Struggler' },
      ],
    }
    expect(readArtistAndAlbum(node)).toEqual({ artist: 'Genesis Owusu', album: 'Struggler' })
  })

  it('leaves both empty for a loose file', () => {
    expect(readArtistAndAlbum({ edges: [] })).toEqual({ artist: '', album: '' })
    expect(readArtistAndAlbum({})).toEqual({ artist: '', album: '' })
  })
})

describe('artworkFor', () => {
  beforeEach(() => {
    const storage = memoryStorage()
    vi.stubGlobal('localStorage', storage)
    vi.stubGlobal('window', { location: { href: 'http://127.0.0.1:5185/' } })
    storeSession({ token: 'token', mediaTicket: 'ticket-123' }, storage, 'http://127.0.0.1:8899')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('points at both cached cover sizes, with the media ticket an <img>-style fetch needs', () => {
    const artwork = artworkFor(12)
    expect(artwork.map((a) => a.sizes)).toEqual(['256x256', '512x512'])
    for (const image of artwork) {
      const url = new URL(image.src)
      expect(url.pathname).toBe('/api/v1/nodes/12/cover')
      expect(url.searchParams.get('t')).toBe('ticket-123')
    }
    expect(artwork.map((a) => new URL(a.src).searchParams.get('size'))).toEqual(['thumb', 'full'])
  })
})
