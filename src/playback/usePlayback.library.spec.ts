// @vitest-environment jsdom
//
// Issue #307: Shuffle library started the player with no title. Its tracks
// come from the map's graph rather than a tracklist, so nothing had cached
// their titles: the player's title line was blank and up next showed
// artists only. Both playback paths are covered, the desktop's (invoke
// mocked as in usePlayback.race.spec.ts) and the browser's <audio>, since
// they set the title in different places.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock, runtime } = vi.hoisted(() => ({ invokeMock: vi.fn(), runtime: { tauri: true } }))

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => runtime.tauri,
  invoke: invokeMock,
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => undefined)),
}))

function makeTrack(id: number) {
  return {
    recordingNodeId: id,
    fileId: id * 10,
    filePath: `/mnt/music/Music/Album/${id}.flac`,
    format: 'flac',
    bitrate: null,
    durationMs: 200_000,
    replaygainTrackGain: null,
    replaygainAlbumGain: null,
  }
}

// What App.tsx's shuffleLibrary hands over: graph nodes, already shuffled.
const SHUFFLED = [
  { id: 30, title: 'Visions of Johanna' },
  { id: 10, title: 'Girl from the North Country' },
  { id: 20, title: 'Tangled Up in Blue' },
]

beforeEach(() => {
  invokeMock.mockReset()
  invokeMock.mockImplementation(async (cmd: string) => (cmd === 'queue_status' ? { volume: 1 } : undefined))
  // POST /queue/resolve is the only request a library shuffle makes, and it
  // returns no titles.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/queue/resolve')) {
        const body = JSON.parse((init?.body as string) ?? '{}') as { recordingNodeIds: number[] }
        return { json: async () => ({ tracks: body.recordingNodeIds.map(makeTrack) }) } as Response
      }
      throw new Error(`usePlayback.library.spec: unexpected fetch ${url}`)
    }),
  )
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// IS_TAURI is read once at module load, so each runtime gets a fresh copy.
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

  return { result, unmount: () => act(() => root.unmount()) }
}

describe.each([
  ['the desktop app', true],
  ['a browser', false],
])('Shuffle library in %s', (_, tauri) => {
  it("shows the first track's title in the player and every title in up next", async () => {
    const { result, unmount } = await renderPlaybackHook(tauri)

    await act(async () => {
      await result.current!.playLibrary(SHUFFLED)
    })

    const playback = result.current!
    expect(playback.status.currentRecordingNodeId).toBe(30)
    expect(playback.currentTitle).toBe('Visions of Johanna')
    expect(playback.upNext.map((e) => e.title)).toEqual(['Girl from the North Country', 'Tangled Up in Blue'])
    unmount()
  })

  it('titles the queue as the library, for up next\'s "Playing from"', async () => {
    const { result, unmount } = await renderPlaybackHook(tauri)

    await act(async () => {
      await result.current!.playLibrary(SHUFFLED)
    })

    expect(result.current!.queueSource).toEqual({ kind: 'library' })
    unmount()
  })
})

describe('Shuffle library in a browser', () => {
  it("moves the player's title on with the queue", async () => {
    const { result, unmount } = await renderPlaybackHook(false)

    await act(async () => {
      await result.current!.playLibrary(SHUFFLED)
    })
    await act(async () => {
      await result.current!.next()
    })

    expect(result.current!.currentTitle).toBe('Girl from the North Country')
    expect(result.current!.upNext.map((e) => e.title)).toEqual(['Tangled Up in Blue'])
    unmount()
  })
})
