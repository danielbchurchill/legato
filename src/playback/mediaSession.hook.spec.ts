// @vitest-environment jsdom
//
// #407: on the iPhone, the lock screen showed play and pause but no next,
// previous or scrubber. WebKit passes a page's actions on to the lock
// screen only while one of its media elements has an active media
// session, through a command list that starts empty each time one becomes
// active (NowPlayingManager and RemoteCommandListener in WebKit's source).
// An action set before then is dropped, and setActionHandler doesn't
// throw. The fake session below works the same way, and these check that
// useMediaSession sets its actions again once the element is playing.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMediaSession, type MediaSessionControls, type MediaSessionLike } from './mediaSession'
import type { PlaybackStatus } from './usePlayback'

class WebKitLikeSession implements MediaSessionLike {
  metadata: MediaMetadata | null = null
  playbackState: MediaSessionPlaybackState = 'none'
  handlers = new Map<MediaSessionAction, MediaSessionActionHandler>()
  // What the lock screen offers: null while no media element is active.
  commands: Set<MediaSessionAction> | null = null
  setPositionState = vi.fn()

  setActionHandler(action: MediaSessionAction, handler: MediaSessionActionHandler | null) {
    if (handler) {
      this.handlers.set(action, handler)
      this.commands?.add(action)
    } else {
      this.handlers.delete(action)
      this.commands?.delete(action)
    }
  }

  // An element starts playing: a fresh, empty command list.
  activate() {
    this.commands = new Set()
  }
}

const STATUS: PlaybackStatus = {
  playing: false,
  positionMs: 0,
  currentRecordingNodeId: null,
  currentFileId: null,
  currentDurationMs: null,
  streaming: false,
  volume: 1,
}

function controls(): MediaSessionControls {
  return { play: vi.fn(), pause: vi.fn(), next: vi.fn(), previous: vi.fn(), seek: vi.fn() }
}

let root: Root | null = null
let session: WebKitLikeSession

beforeEach(() => {
  session = new WebKitLikeSession()
  vi.stubGlobal('navigator', { ...navigator, mediaSession: session })
  vi.stubGlobal(
    'MediaMetadata',
    class {
      constructor(init: MediaMetadataInit) {
        Object.assign(this, init)
      }
    },
  )
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({ edges: [] }) })),
  )
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  vi.unstubAllGlobals()
})

function render(element: EventTarget, status: PlaybackStatus, playerControls = controls()) {
  function Harness({ status }: { status: PlaybackStatus }) {
    useMediaSession({ enabled: true, status, title: 'Struggler', controls: playerControls, element })
    return null
  }
  if (!root) root = createRoot(document.createElement('div'))
  act(() => root!.render(createElement(Harness, { status })))
}

describe('useMediaSession on WebKit (#407)', () => {
  it('sets next, previous and the scrubber again once the element plays, so the lock screen has them', () => {
    const audio = new EventTarget()
    render(audio, STATUS)
    // Set when the app loaded, before anything had played: dropped.
    expect(session.commands).toBeNull()

    // Playback starts: the element's session becomes the one on the lock
    // screen, with nothing on it yet.
    session.activate()
    act(() => void audio.dispatchEvent(new Event('playing')))

    expect([...session.commands!].sort()).toEqual(['nexttrack', 'pause', 'play', 'previoustrack', 'seekto'])
  })

  it('sets them again each time playback starts, after a load failure ended the last session', () => {
    const audio = new EventTarget()
    render(audio, STATUS)
    session.activate()
    act(() => void audio.dispatchEvent(new Event('playing')))
    session.activate()
    expect(session.commands!.size).toBe(0)

    act(() => void audio.dispatchEvent(new Event('playing')))
    expect(session.commands!.has('nexttrack')).toBe(true)
  })

  it('routes a headphone or lock-screen next to the player that is current', () => {
    const audio = new EventTarget()
    const first = controls()
    render(audio, STATUS, first)
    const second = controls()
    render(audio, STATUS, second)
    session.activate()
    act(() => void audio.dispatchEvent(new Event('playing')))

    session.handlers.get('nexttrack')!({ action: 'nexttrack' })
    session.handlers.get('previoustrack')!({ action: 'previoustrack' })
    expect(first.next).not.toHaveBeenCalled()
    expect(second.next).toHaveBeenCalledTimes(1)
    expect(second.previous).toHaveBeenCalledTimes(1)
  })

  it('places the scrubber when playback starts, then sets the playback state after it', () => {
    const audio = new EventTarget()
    render(audio, { ...STATUS, playing: true, positionMs: 12_000, currentRecordingNodeId: 7, currentDurationMs: 200_000 })
    session.setPositionState.mockClear()
    session.playbackState = 'none'

    session.activate()
    act(() => void audio.dispatchEvent(new Event('playing')))
    expect(session.setPositionState).toHaveBeenLastCalledWith({ duration: 200, position: 12, playbackRate: 1 })
    expect(session.playbackState).toBe('playing')
  })

  it('stops listening for playback and unhooks the buttons when the player goes', () => {
    const audio = new EventTarget()
    render(audio, STATUS)
    session.activate()
    act(() => root!.unmount())
    root = null
    act(() => void audio.dispatchEvent(new Event('playing')))
    expect(session.commands!.size).toBe(0)
    expect(session.handlers.size).toBe(0)
  })
})
