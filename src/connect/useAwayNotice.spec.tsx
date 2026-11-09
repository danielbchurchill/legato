// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { noteTapeQuality, streamUrl } from '../playback/quality'
import type { usePlayback } from '../playback/usePlayback'
import { awayFromHome } from './awayFromHome'
import { interruptedNow, useAwayNotice, useWhereaboutsFeed, type AwayNoticeView } from './useAwayNotice'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// #412: what opens the notice, and what holds it back.

const roots: Root[] = []
let sockets: { onmessage: ((m: { data: string }) => void) | null; close: () => void }[] = []

beforeEach(() => {
  sockets = []
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 0))
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
  vi.stubGlobal(
    'WebSocket',
    class {
      onmessage: ((m: { data: string }) => void) | null = null
      onopen = null
      onclose = null
      constructor() {
        sockets.push(this)
      }
      close() {}
    },
  )
})

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()))
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
  // Back to a device that's never been away.
  act(() => {
    awayFromHome.setWhereabouts('home')
    awayFromHome.setQuality('tell')
  })
  localStorage.clear()
  awayFromHome.reload()
})

const FLAC = { format: 'FLAC', bitrate: 900_000, sampleRate: 44100 }

function playback(file = FLAC, fileId = 7) {
  return {
    status: {
      playing: true,
      positionMs: 0,
      currentRecordingNodeId: 5,
      currentFileId: fileId,
      currentDurationMs: 200_000,
      streaming: false,
      volume: 1,
    },
    playingFile: file,
    currentTitle: 'Like a Rolling Stone',
  } as unknown as ReturnType<typeof usePlayback>
}

// Several turns: a wait ending, the render it brings, then the frame.
const frames = async () => {
  for (let i = 0; i < 4; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 10)))
}

async function host(pb = playback()) {
  const seen: { latest: AwayNoticeView | null } = { latest: null }
  const announce = vi.fn()
  function Host() {
    useWhereaboutsFeed()
    seen.latest = useAwayNotice(pb, announce)
    return createElement('input', { id: 'field', type: 'search' })
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => root.render(createElement(Host)))
  return { view: () => seen.latest!, announce }
}

const say = (where: string) =>
  act(() => sockets.forEach((s) => s.onmessage?.({ data: JSON.stringify({ event: 'device:where', payload: { where } }) })))

describe('useAwayNotice', () => {
  it("opens on the first frame once the server says 'away' and the track streams the original", async () => {
    noteTapeQuality(7, 'original-fmp4')
    const { view } = await host()
    expect(view().open).toBe(false)
    await say('away')
    await frames()
    expect(view().open).toBe(true)
    expect(view().server).toBe('your server')
    expect(view().rows.map((r) => r.figure)).toEqual(['400 MB', '72 MB'])
  })

  it("doesn't open while the server says 'home' or doesn't know", async () => {
    noteTapeQuality(7, 'original-fmp4')
    const { view } = await host()
    await say('unknown')
    await frames()
    await say('home')
    await frames()
    expect(view().open).toBe(false)
  })

  it('waits for a text field in use, and opens once it lets go', async () => {
    noteTapeQuality(7, 'original-fmp4')
    const { view } = await host()
    const field = document.getElementById('field') as HTMLInputElement
    field.focus()
    await say('away')
    await frames()
    expect(view().open).toBe(false)
    act(() => field.blur())
    await frames()
    expect(view().open).toBe(true)
  })

  it("doesn't open for a track that isn't streaming the original", async () => {
    // What the player last asked for was the original of another file.
    noteTapeQuality(8, 'original-fmp4')
    const { view } = await host()
    await say('away')
    await frames()
    expect(view().open).toBe(false)
  })

  it("doesn't open for a file under 320 kbps", async () => {
    noteTapeQuality(7, 'original-fmp4')
    const { view } = await host(playback({ format: 'MPEG', bitrate: 128_000, sampleRate: 44100 }))
    await say('away')
    await frames()
    expect(view().open).toBe(false)
  })

  it('announces each choice, and closes on it', async () => {
    noteTapeQuality(7, 'original-fmp4')
    const { view, announce } = await host()
    await say('away')
    await frames()
    act(() => view().onStandard())
    expect(view().open).toBe(false)
    expect(awayFromHome.snapshot().quality).toBe('standard')
    expect(announce).toHaveBeenCalledWith('standard while away is on. The next track streams at 160 kbps.')
    act(() => view().onKeep())
    expect(announce).toHaveBeenLastCalledWith('This notice is off. Settings → playback turns it back on.')
  })

  it("puts standard while away into the next stream's URL, only while away", async () => {
    act(() => awayFromHome.setQuality('standard'))
    await host()
    await say('away')
    expect(streamUrl(9)).toMatch(/quality=(opus160|aac160)/)
    await say('unknown')
    expect(streamUrl(9)).not.toMatch(/quality=(opus160|aac160)/)
  })
})

describe('interruptedNow', () => {
  it('is a held press, a text field or a select in use, or a menu, picker or other dialog open', () => {
    document.body.innerHTML = `
      <input id="text" type="text"><input id="range" type="range"><select id="pick"></select>
      <button id="plain">plain</button>`
    expect(interruptedNow(document, 0)).toBe(false)
    expect(interruptedNow(document, 1)).toBe(true)
    document.getElementById('text')!.focus()
    expect(interruptedNow(document, 0)).toBe(true)
    document.getElementById('range')!.focus()
    expect(interruptedNow(document, 0)).toBe(false)
    document.getElementById('pick')!.focus()
    expect(interruptedNow(document, 0)).toBe(true)
    document.getElementById('plain')!.focus()

    for (const open of [
      '<button aria-haspopup="menu" aria-expanded="true"></button>',
      '<ul role="listbox"></ul>',
      '<div role="menu"></div>',
      '<div role="alertdialog"></div>',
      '<div role="dialog" aria-modal="true" aria-label="Search"></div>',
      '<div data-connect-screen></div>',
    ]) {
      const el = document.createElement('div')
      el.innerHTML = open
      document.body.appendChild(el)
      expect(interruptedNow(document, 0)).toBe(true)
      el.remove()
    }
  })

  it('goes over now playing on the phone, a closed popover and a map card', () => {
    document.body.innerHTML = `
      <section role="dialog" aria-modal="true" aria-label="Now playing" data-now-playing></section>
      <button aria-haspopup="dialog" aria-expanded="false"></button>
      <div role="dialog" aria-label="Like a Rolling Stone"></div>`
    expect(interruptedNow(document, 0)).toBe(false)
  })
})
