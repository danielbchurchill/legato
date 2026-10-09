// @vitest-environment jsdom
//
// Issue #119: the web player's queue and position survive the server going
// away and coming back. The shell, and this hook with it, stays mounted
// through the outage (App.tsx), so nothing about the queue is lost. What
// dies is the <audio> element's source, and SERVER_BACK_EVENT brings that
// back where it stopped. These drive the browser path (isTauri false) with
// a stand-in element whose loads fail while the fake server is down.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SERVER_BACK_EVENT } from '../connect/unreachable'

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false, invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }))

import { usePlayback } from './usePlayback'

const server = { up: true }

// MediaError codes, as the element reports them.
const NETWORK = 2
const SRC_NOT_SUPPORTED = 4

class FakeAudio extends EventTarget {
  static made: FakeAudio[] = []
  error: { code: number } | null = null
  paused = true
  seeking = false
  volume = 1
  currentTime = 0
  #src = ''

  constructor() {
    super()
    FakeAudio.made.push(this)
  }

  get src() {
    return this.#src
  }

  // A new source starts a new load from 0. With the server gone the load
  // fails before any of it arrives, which an element reports as "not
  // supported".
  set src(value: string) {
    this.#src = value
    this.currentTime = 0
    this.error = server.up ? null : { code: SRC_NOT_SUPPORTED }
    if (!server.up) this.fire('error')
  }

  play = vi.fn(async () => {
    if (this.error) throw new DOMException('Failed to load because no supported source was found.', 'NotSupportedError')
    this.paused = false
    this.fire('playing')
  })

  pause = vi.fn(() => {
    this.paused = true
    this.fire('pause')
  })

  canPlayType() {
    return 'probably'
  }

  load() {}

  removeAttribute(name: string) {
    if (name === 'src') this.#src = ''
  }

  fire(type: string) {
    this.dispatchEvent(new Event(type))
  }
}

const TRACKLIST = [
  { id: 1, title: 'One', track_no: 1, canonical_duration_ms: 200_000 },
  { id: 2, title: 'Two', track_no: 2, canonical_duration_ms: 200_000 },
  { id: 3, title: 'Three', track_no: 3, canonical_duration_ms: 200_000 },
]

function resolved(id: number) {
  return {
    recordingNodeId: id,
    fileId: id * 10,
    filePath: `/music/${id}.flac`,
    format: 'flac',
    bitrate: null,
    durationMs: 200_000,
    replaygainTrackGain: null,
    replaygainAlbumGain: null,
  }
}

type Playback = ReturnType<typeof usePlayback>

describe('usePlayback across a server outage (web player)', () => {
  let root: Root | null = null

  beforeEach(() => {
    server.up = true
    FakeAudio.made = []
    vi.stubGlobal('Audio', FakeAudio)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (!server.up) throw new TypeError('Failed to fetch')
        if (url.endsWith('/nodes/9/tracklist')) return { ok: true, json: async () => TRACKLIST } as Response
        if (url.endsWith('/queue/resolve')) {
          const { recordingNodeIds } = JSON.parse(init?.body as string) as { recordingNodeIds: number[] }
          return { ok: true, json: async () => ({ tracks: recordingNodeIds.map(resolved) }) } as Response
        }
        return { ok: true, json: async () => ({}) } as Response
      }),
    )
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    vi.unstubAllGlobals()
  })

  async function mount() {
    const result: { current: Playback | null } = { current: null }
    function Harness() {
      result.current = usePlayback()
      return null
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    await act(async () => {
      root = createRoot(container)
      root.render(createElement(Harness))
    })
    return result as { current: Playback }
  }

  // The element the hook plays through: the one given a stream to load
  // (quality.ts makes a second, only to ask what it can play).
  const player = () => FakeAudio.made.find((a) => a.src.includes('/stream'))!

  const titles = (playback: Playback) => playback.upNext.map((e) => e.title)

  it('keeps the queue through an outage, and reloads the track where it stopped once the server is back', async () => {
    const playback = await mount()
    await act(async () => playback.current.playAlbum(9))
    const audio = player()
    expect(audio.src).toContain('/files/10/stream')
    expect(playback.current.status.playing).toBe(true)

    await act(async () => {
      audio.currentTime = 83
      audio.fire('timeupdate')
    })

    // The server dies mid-track: the stream breaks once the buffer runs out.
    server.up = false
    await act(async () => {
      audio.error = { code: NETWORK }
      audio.fire('error')
    })
    expect(playback.current.status.playing).toBe(false)
    expect(playback.current.currentTitle).toBe('One')
    expect(titles(playback.current)).toEqual(['Two', 'Three'])

    // It's back.
    server.up = true
    await act(async () => {
      window.dispatchEvent(new Event(SERVER_BACK_EVENT))
    })
    expect(audio.error).toBeNull()
    expect(audio.src).toContain('/files/10/stream')
    expect(audio.currentTime).toBe(83)
    expect(playback.current.status.positionMs).toBe(83_000)
    expect(playback.current.currentTitle).toBe('One')
    expect(titles(playback.current)).toEqual(['Two', 'Three'])

    // Paused, as any drop leaves it (#120); play picks up from there.
    expect(audio.paused).toBe(true)
    await act(async () => playback.current.resume())
    expect(playback.current.status.playing).toBe(true)
    expect(audio.currentTime).toBe(83)
    expect(FakeAudio.made.filter((a) => a.play.mock.calls.length > 0)).toEqual([audio])
  })

  it('brings back a track that came up while the server was gone and could not start', async () => {
    const playback = await mount()
    await act(async () => playback.current.playAlbum(9))
    const audio = player()

    // The first track was buffered to the end, so it finishes during the
    // outage, and the next one can't load.
    server.up = false
    await act(async () => {
      audio.currentTime = 199.6
      audio.fire('ended')
    })
    expect(audio.src).toContain('/files/20/stream')
    expect(audio.error).toEqual({ code: SRC_NOT_SUPPORTED })
    expect(playback.current.status.playing).toBe(false)
    expect(playback.current.currentTitle).toBe('Two')
    expect(titles(playback.current)).toEqual(['Three'])

    server.up = true
    await act(async () => {
      window.dispatchEvent(new Event(SERVER_BACK_EVENT))
    })
    expect(audio.error).toBeNull()
    expect(audio.src).toContain('/files/20/stream')

    await act(async () => playback.current.resume())
    expect(playback.current.status.playing).toBe(true)
    expect(playback.current.currentTitle).toBe('Two')
    expect(titles(playback.current)).toEqual(['Three'])
  })

  // What headless Chrome did on one kill: the cut stream played out what
  // had arrived and fired `ended` at 0:58 of a 3:00 track.
  it("doesn't move on when a cut stream ends the track early, and picks it up there once the server is back", async () => {
    const playback = await mount()
    await act(async () => playback.current.playAlbum(9))
    const audio = player()

    server.up = false
    await act(async () => {
      audio.currentTime = 58
      audio.fire('timeupdate')
      audio.paused = true
      audio.fire('ended')
    })
    expect(playback.current.currentTitle).toBe('One')
    expect(titles(playback.current)).toEqual(['Two', 'Three'])
    expect(playback.current.status.playing).toBe(false)
    expect(audio.src).toContain('/files/10/stream')

    server.up = true
    await act(async () => {
      window.dispatchEvent(new Event(SERVER_BACK_EVENT))
    })
    expect(audio.error).toBeNull()
    expect(audio.src).toContain('/files/10/stream')
    expect(audio.currentTime).toBe(58)

    await act(async () => playback.current.resume())
    expect(playback.current.status.playing).toBe(true)
    expect(playback.current.currentTitle).toBe('One')
    expect(titles(playback.current)).toEqual(['Two', 'Three'])
  })

  // The coordinator's #120 check found an element still playing after the
  // shell it belonged to had gone, with nothing on screen to pause it.
  it('silences its own element when it unmounts, so no sound outlives the player', async () => {
    const playback = await mount()
    await act(async () => playback.current.playAlbum(9))
    const audio = player()
    expect(audio.paused).toBe(false)

    act(() => root?.unmount())
    root = null

    expect(audio.paused).toBe(true)
    expect(audio.src).toBe('')
  })
})
