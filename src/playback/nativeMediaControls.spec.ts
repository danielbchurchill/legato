// @vitest-environment jsdom
//
// #131: media keys and the OS's now-playing widget for native playback.
// invoke and listen are mocked; media_controls.rs's own tests cover the
// Rust side of each command and event.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlaybackStatus } from './usePlayback'

type Handler = (event: { payload: unknown }) => void

const { invokeMock, handlers, listenMock } = vi.hoisted(() => {
  const handlers = new Map<string, Handler>()
  return {
    invokeMock: vi.fn(async () => undefined),
    handlers,
    listenMock: vi.fn((name: string, handler: Handler) => {
      handlers.set(name, handler)
      return Promise.resolve(() => undefined)
    }),
  }
})

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: invokeMock }))
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }))

import { storeSession } from '../auth/session'
import {
  DRIFT_MS,
  needsSync,
  runMediaControl,
  useNativeMediaControls,
  type NativeMediaControl,
  type NativeMediaControls,
} from './nativeMediaControls'

const IDLE: PlaybackStatus = {
  playing: false,
  positionMs: 0,
  currentRecordingNodeId: null,
  currentFileId: null,
  currentDurationMs: null,
  streaming: false,
  volume: 1,
}

// One component for every render, so a re-render keeps the hook's state.
function Harness(props: Parameters<typeof useNativeMediaControls>[0]) {
  useNativeMediaControls(props)
  return null
}

const PLAYING: PlaybackStatus = { ...IDLE, playing: true, positionMs: 30_000, currentRecordingNodeId: 7, currentDurationMs: 200_000 }

function fakeControls(): NativeMediaControls {
  return { play: vi.fn(), pause: vi.fn(), next: vi.fn(), previous: vi.fn(), seek: vi.fn(), stop: vi.fn() }
}

describe('runMediaControl', () => {
  it('sends each button to the control the transport uses', () => {
    for (const action of ['play', 'pause', 'next', 'previous', 'stop'] as const) {
      const controls = fakeControls()
      runMediaControl({ action }, controls, PLAYING)
      expect(controls[action]).toHaveBeenCalledOnce()
    }
  })

  it('toggles by what the transport is doing', () => {
    const controls = fakeControls()
    runMediaControl({ action: 'toggle' }, controls, PLAYING)
    runMediaControl({ action: 'toggle' }, controls, { ...PLAYING, playing: false })
    expect(controls.pause).toHaveBeenCalledOnce()
    expect(controls.play).toHaveBeenCalledOnce()
  })

  it('seeks to a position, or by an offset, inside the track', () => {
    const cases: [NativeMediaControl, number][] = [
      [{ action: 'seek', position_ms: 83_500 }, 83_500],
      [{ action: 'seek', position_ms: 999_000 }, 200_000],
      [{ action: 'seek_by', offset_ms: 10_000 }, 40_000],
      [{ action: 'seek_by', offset_ms: -45_000 }, 0],
    ]
    for (const [control, landsAt] of cases) {
      const controls = fakeControls()
      runMediaControl(control, controls, PLAYING)
      expect(controls.seek).toHaveBeenCalledWith(landsAt)
    }
  })
})

describe('needsSync', () => {
  const last = { nodeId: 7, playing: true, positionMs: 30_000, at: 1000 }

  it('says nothing while the position moves on as the OS would have it', () => {
    expect(needsSync(last, { nodeId: 7, playing: true, positionMs: 32_000 }, 3000)).toBe(false)
    expect(needsSync({ ...last, playing: false }, { nodeId: 7, playing: false, positionMs: 30_000 }, 9000)).toBe(false)
  })

  it('tells the OS of a new track, play or pause, and a jump', () => {
    expect(needsSync(null, { nodeId: 7, playing: true, positionMs: 0 }, 0)).toBe(true)
    expect(needsSync(last, { nodeId: 8, playing: true, positionMs: 0 }, 1250)).toBe(true)
    expect(needsSync(last, { nodeId: 7, playing: false, positionMs: 30_250 }, 1250)).toBe(true)
    expect(needsSync(last, { nodeId: 7, playing: true, positionMs: 90_000 }, 1250)).toBe(true)
    expect(needsSync(last, { nodeId: 7, playing: true, positionMs: 30_250 + DRIFT_MS + 100 }, 1250)).toBe(true)
  })
})

describe('useNativeMediaControls', () => {
  let root: Root | null = null
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    handlers.clear()
    invokeMock.mockClear()
    listenMock.mockClear()
    storeSession({ token: 'session-token', mediaTicket: 'media-ticket' })
    fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        edges: [
          { direction: 'out', type: 'performed_by', other_title: 'Artist' },
          { direction: 'out', type: 'appears_on', other_title: 'Album' },
        ],
      }),
    }))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    localStorage.clear()
    vi.unstubAllGlobals()
  })

  function render(props: { enabled?: boolean; status: PlaybackStatus; title?: string | null; controls?: NativeMediaControls }) {
    const all = { enabled: true, title: 'Song', controls: fakeControls(), ...props }
    act(() => {
      root ??= createRoot(document.createElement('div'))
      root.render(createElement(Harness, all))
    })
    return all.controls
  }

  const calls = (cmd: string) => invokeMock.mock.calls.filter((call) => (call as unknown[])[0] === cmd).map((call) => (call as unknown[])[1])

  it('shows the track with its artist, album and cover, and the cover carries the media ticket only to the shell', async () => {
    render({ status: PLAYING })
    await act(async () => {
      await Promise.resolve()
    })

    const tracks = calls('media_controls_set_track') as { track: Record<string, unknown> }[]
    expect(tracks.map((t) => [t.track.title, t.track.artist, t.track.album])).toEqual([
      ['Song', '', ''],
      ['Song', 'Artist', 'Album'],
    ])
    expect(tracks[0].track).toMatchObject({ recording_node_id: 7, duration_ms: 200_000 })
    const cover = new URL(tracks[0].track.cover_url as string)
    expect(cover.pathname).toBe('/api/v1/nodes/7/cover')
    expect(cover.searchParams.get('size')).toBe('full')
    expect(cover.searchParams.get('t')).toBe('media-ticket')
  })

  it("keeps a recording's artist and album when its title changes", async () => {
    render({ status: PLAYING, title: '' })
    await act(async () => {
      await Promise.resolve()
    })
    render({ status: PLAYING, title: 'Song' })

    const last = (calls('media_controls_set_track') as { track: Record<string, unknown> }[]).at(-1)!.track
    expect([last.title, last.artist, last.album]).toEqual(['Song', 'Artist', 'Album'])
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('says where playback is on a new track, play or pause, and a seek, but not every tick', () => {
    render({ status: PLAYING })
    render({ status: { ...PLAYING, positionMs: 30_250 } })
    render({ status: { ...PLAYING, positionMs: 30_250, playing: false } })
    render({ status: { ...PLAYING, positionMs: 120_000, playing: false } })

    expect(calls('media_controls_set_playback')).toEqual([
      { recordingNodeId: 7, playing: true, positionMs: 30_000 },
      { recordingNodeId: 7, playing: false, positionMs: 30_250 },
      { recordingNodeId: 7, playing: false, positionMs: 120_000 },
    ])
  })

  it('clears the widget when nothing is playing', () => {
    render({ status: IDLE })
    expect(calls('media_controls_clear')).toHaveLength(1)
    expect(calls('media_controls_set_track')).toHaveLength(0)
  })

  it('runs a button pressed in the OS on the player as it is now', () => {
    const controls = render({ status: PLAYING })

    act(() => handlers.get('playback://media-control')!({ payload: { action: 'toggle' } }))
    render({ status: { ...PLAYING, playing: false }, controls })
    act(() => handlers.get('playback://media-control')!({ payload: { action: 'toggle' } }))
    act(() => handlers.get('playback://media-control')!({ payload: { action: 'next' } }))

    expect(controls.pause).toHaveBeenCalledOnce()
    expect(controls.play).toHaveBeenCalledOnce()
    expect(controls.next).toHaveBeenCalledOnce()
  })

  it('ignores the keys with nothing in the transport, but not after a track failed to start', () => {
    const controls = render({ status: IDLE, title: null })
    act(() => handlers.get('playback://media-control')!({ payload: { action: 'toggle' } }))
    expect(controls.play).not.toHaveBeenCalled()

    // A failed start keeps its title, and play tries the track again.
    render({ status: IDLE, title: 'Song', controls })
    act(() => handlers.get('playback://media-control')!({ payload: { action: 'toggle' } }))
    expect(controls.play).toHaveBeenCalledOnce()
  })

  it('does nothing in the browser', () => {
    render({ enabled: false, status: PLAYING })
    expect(invokeMock).not.toHaveBeenCalled()
    expect(listenMock).not.toHaveBeenCalled()
  })
})
