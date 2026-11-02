// @vitest-environment jsdom
//
// Issue #444: a queue started from a track list (an album's or a track's
// article, a producer's tracks, a playlist) lost its titles. POST
// /queue/resolve has none, and playTracks only titled an entry something
// else had cached, so up next showed artists and durations alone, and the
// web player's transport and lock screen went blank from the second track.
// Every test here starts with nothing cached, as a fresh session does, on
// both playback paths: the desktop's (invoke mocked as in
// usePlayback.race.spec.ts) and the browser's <audio>.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock, handlers, runtime } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
  runtime: { tauri: true },
}))

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => runtime.tauri,
  invoke: invokeMock,
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    handlers.set(name, handler)
    return Promise.resolve(() => undefined)
  }),
}))

function makeTrack(id: number) {
  return {
    recordingNodeId: id,
    fileId: id * 10,
    filePath: `/mnt/music/Bob Dylan/Highway 61 Revisited/${id}.flac`,
    format: 'flac',
    bitrate: null,
    durationMs: 200_000,
    replaygainTrackGain: null,
    replaygainAlbumGain: null,
  }
}

// An album's track list, as GET /nodes/:id/tracklist gives it to the
// article's tracks tab.
const TRACKLIST = [
  { id: 10, title: 'Like a Rolling Stone', track_no: 1, canonical_duration_ms: 369_000 },
  { id: 20, title: 'Tombstone Blues', track_no: 2, canonical_duration_ms: 358_000 },
  { id: 30, title: 'It Takes a Lot to Laugh, It Takes a Train to Cry', track_no: 3, canonical_duration_ms: 249_000 },
  { id: 40, title: 'From a Buick 6', track_no: 4, canonical_duration_ms: 199_000 },
]
const TITLES = new Map(TRACKLIST.map((t) => [t.id, t.title]))

const nodeFetches: number[] = []

beforeEach(() => {
  nodeFetches.length = 0
  handlers.clear()
  invokeMock.mockReset()
  invokeMock.mockImplementation(async (cmd: string) => (cmd === 'queue_status' ? { volume: 1 } : undefined))
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/queue/resolve')) {
        const body = JSON.parse((init?.body as string) ?? '{}') as { recordingNodeIds: number[] }
        return { json: async () => ({ tracks: body.recordingNodeIds.map(makeTrack) }) } as Response
      }
      const node = url.match(/\/nodes\/(\d+)$/)
      if (node) {
        const id = Number(node[1])
        nodeFetches.push(id)
        return { json: async () => ({ id, title: TITLES.get(id) ?? '', edges: [] }) } as Response
      }
      throw new Error(`usePlayback.titles.spec: unexpected fetch ${url}`)
    }),
  )
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// IS_TAURI is read once at module load, so each runtime gets a fresh copy,
// and with it an empty title cache.
async function renderPlaybackHook(tauri: boolean) {
  runtime.tauri = tauri
  vi.resetModules()
  const { usePlayback } = await import('./usePlayback')

  const container = document.createElement('div')
  document.body.appendChild(container)
  let root!: Root
  const result: { current: ReturnType<typeof usePlayback> | null } = { current: null }

  function Harness() {
    result.current = usePlayback('track')
    return null
  }

  act(() => {
    root = createRoot(container)
    root.render(createElement(Harness))
  })
  await act(async () => undefined)

  return { result, unmount: () => act(() => root.unmount()) }
}

describe.each([
  ['the desktop app', true],
  ['a browser', false],
])('Playing from a track list in %s', (_, tauri) => {
  it('titles the playing track and every track up next', async () => {
    const { result, unmount } = await renderPlaybackHook(tauri)

    // Clicking the album's first track in its tracks tab.
    await act(async () => {
      await result.current!.playTracks(TRACKLIST, 0, { kind: 'release', nodeId: 1 })
    })

    expect(result.current!.currentTitle).toBe('Like a Rolling Stone')
    expect(result.current!.upNext.map((e) => e.title)).toEqual([
      'Tombstone Blues',
      'It Takes a Lot to Laugh, It Takes a Train to Cry',
      'From a Buick 6',
    ])
    // The list's own titles: nothing needed looking up.
    expect(nodeFetches).toEqual([])
    unmount()
  })

  it('titles the tracks before the one clicked, for previous', async () => {
    const { result, unmount } = await renderPlaybackHook(tauri)

    await act(async () => {
      await result.current!.playTracks(TRACKLIST, 2, { kind: 'release', nodeId: 1 })
    })
    expect(result.current!.currentTitle).toBe('It Takes a Lot to Laugh, It Takes a Train to Cry')
    expect(result.current!.upNext.map((e) => e.title)).toEqual(['From a Buick 6'])

    for (const title of ['Tombstone Blues', 'Like a Rolling Stone']) {
      await act(async () => {
        await result.current!.previous()
      })
      expect(result.current!.currentTitle).toBe(title)
    }
    expect(result.current!.upNext.map((e) => e.title)).toEqual([
      'Tombstone Blues',
      'It Takes a Lot to Laugh, It Takes a Train to Cry',
      'From a Buick 6',
    ])
    unmount()
  })

  it('looks up a title the list left empty before queueing it', async () => {
    const { result, unmount } = await renderPlaybackHook(tauri)

    // What a list of ids alone, such as a node's credited tracks, comes to
    // when the map hasn't named every one.
    await act(async () => {
      await result.current!.playTracks(
        TRACKLIST.map((t) => ({ id: t.id, title: t.id === 10 ? t.title : '' })),
        0,
      )
    })

    expect(result.current!.currentTitle).toBe('Like a Rolling Stone')
    expect(result.current!.upNext.map((e) => e.title)).toEqual([
      'Tombstone Blues',
      'It Takes a Lot to Laugh, It Takes a Train to Cry',
      'From a Buick 6',
    ])
    expect(nodeFetches.sort()).toEqual([20, 30, 40])
    unmount()
  })

  it('looks up the title of the clicked track too', async () => {
    const { result, unmount } = await renderPlaybackHook(tauri)

    await act(async () => {
      await result.current!.playTracks(
        TRACKLIST.map((t) => ({ id: t.id, title: '' })),
        1,
      )
    })

    expect(result.current!.currentTitle).toBe('Tombstone Blues')
    expect(result.current!.upNext.map((e) => e.title)).toEqual(['It Takes a Lot to Laugh, It Takes a Train to Cry', 'From a Buick 6'])
    unmount()
  })
})

describe('Playing from a track list in a browser', () => {
  // The transport's title line and the lock screen (mediaSession.ts) both
  // read currentTitle, which the web player takes from the entry it moves to.
  it("moves the player's title on with the queue", async () => {
    const { result, unmount } = await renderPlaybackHook(false)

    await act(async () => {
      await result.current!.playTracks(TRACKLIST, 0, { kind: 'release', nodeId: 1 })
    })
    for (const title of ['Tombstone Blues', 'It Takes a Lot to Laugh, It Takes a Train to Cry', 'From a Buick 6']) {
      await act(async () => {
        await result.current!.next()
      })
      expect(result.current!.currentTitle).toBe(title)
    }
    expect(result.current!.upNext).toEqual([])
    unmount()
  })
})

describe('Playing from a track list in the desktop app', () => {
  it('keeps up next titled as the engine moves on to the next track', async () => {
    const { result, unmount } = await renderPlaybackHook(true)

    await act(async () => {
      await result.current!.playTracks(TRACKLIST, 0, { kind: 'release', nodeId: 1 })
    })
    await act(async () => {
      handlers.get('playback://track-changed')!({ payload: { recording_node_id: 20, streaming: false } })
    })

    expect(result.current!.currentTitle).toBe('Tombstone Blues')
    expect(result.current!.upNext.map((e) => e.title)).toEqual(['It Takes a Lot to Laugh, It Takes a Train to Cry', 'From a Buick 6'])
    unmount()
  })
})
