// @vitest-environment jsdom
import { act, createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { noticeRows } from '../connect/awayNotice'
import type { AwayNoticeView } from '../connect/useAwayNotice'
import type { usePlayback } from '../playback/usePlayback'
import { AwayNoticeSheet } from './AwayNoticeSheet'
import { onNoticeEntry } from './navigation'
import type { PlayingTrack } from './usePlayingTrack'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// #412: the away-from-home notice on the phone, a sheet of its own over
// everything, with play/pause in it.

const roots: Root[] = []

beforeEach(() => {
  history.replaceState(null, '')
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })),
  )
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 0))
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }) as Response),
  )
})

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()))
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const frames = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)))

function view(overrides: Partial<AwayNoticeView> = {}): AwayNoticeView {
  return {
    open: true,
    server: 'raspberrypi',
    rows: noticeRows({ format: 'FLAC', bitrate: 900_000, sampleRate: 44100 })!,
    onStandard: vi.fn(),
    onKeep: vi.fn(),
    onDismiss: vi.fn(),
    ...overrides,
  }
}

function playback(playing = true) {
  return {
    status: {
      playing,
      positionMs: 0,
      currentRecordingNodeId: 5,
      currentFileId: 7,
      currentDurationMs: 200_000,
      streaming: false,
      volume: 1,
    },
    currentTitle: 'Like a Rolling Stone',
    queueBusy: false,
    pause: vi.fn(),
    resume: vi.fn(),
  } as unknown as ReturnType<typeof usePlayback>
}

const track = { nodeId: 5, artist: 'Bob Dylan', album: 'Highway 61 Revisited' } as PlayingTrack

async function render(initial: AwayNoticeView, pb = playback()) {
  const container = document.createElement('main')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  // Beside it, as in PhoneShell: what it goes over, the map and the sheet.
  const draw = (v: AwayNoticeView) =>
    act(async () =>
      root.render(
        createElement(
          Fragment,
          null,
          createElement('div', { id: 'shell' }, createElement('button', { id: 'opener' }, 'had the focus')),
          createElement(AwayNoticeSheet, { view: v, playback: pb, track }),
        ),
      ),
    )
  await draw({ ...initial, open: false })
  const shell = document.getElementById('shell')!
  const opener = document.getElementById('opener')!
  opener.focus()
  await draw(initial)
  await frames()
  return { container, shell, opener, draw, pb }
}

const sheet = () => document.querySelector<HTMLElement>('[role="dialog"]')!
const button = (name: string) =>
  [...sheet().querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent?.trim()) === name)!

describe('AwayNoticeSheet', () => {
  it('is a modal dialog named by its title and described by its body and rows', async () => {
    await render(view())
    const dialog = sheet()
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)!.textContent).toBe('Still streaming originals')
    const description = dialog
      .getAttribute('aria-describedby')!
      .split(' ')
      .map((id) => document.getElementById(id)!.textContent)
      .join(' ')
    expect(description).toContain('This device is away from home, and raspberrypi is still sending each track as its original file.')
    expect(description).toContain('original, FLAC 44.1 kilohertz: about 400 megabytes an hour.')
    expect(description).toContain('standard, 160 kilobits a second: about 72 megabytes an hour.')
    // The bars and the visible figures are hidden from a screen reader.
    expect(dialog.querySelectorAll('[aria-hidden="true"] .mono').length).toBe(4)
  })

  it('draws the copy as the handoff writes it', async () => {
    await render(view())
    const text = sheet().textContent!
    expect(text).toContain('originalFLAC 44.1 kHzabout400 MBan hour')
    expect(text).toContain('standard160 kbpsabout72 MBan hour')
    expect(text).toContain(
      'standard while away starts with the next track and changes nothing at home. keep original turns this notice off. Settings → playback has both.',
    )
  })

  it('takes the focus itself, and Tab goes play/pause, close, keep original, standard while away', async () => {
    await render(view())
    expect(document.activeElement).toBe(sheet())
    const order = [...sheet().querySelectorAll<HTMLElement>('button')].map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim())
    expect(order).toEqual(['Pause', 'Close', 'keep original', 'standard while away'])

    // Tab from the last wraps to the first; Shift-Tab from the surface goes to the last.
    button('standard while away').focus()
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    document.dispatchEvent(tab)
    expect(tab.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(button('Pause'))
  })

  it('keeps play/pause working while it is open', async () => {
    const { pb } = await render(view())
    act(() => button('Pause').click())
    expect(pb.pause).toHaveBeenCalledOnce()
  })

  it('puts everything else out of reach while open, and gives the focus back on close', async () => {
    const { shell, opener, draw } = await render(view())
    expect(shell.inert).toBe(true)
    await draw(view({ open: false }))
    await frames()
    expect(shell.inert).toBe(false)
    expect(document.activeElement).toBe(opener)
    // Gone once its exit has played.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 150)))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('closes without choosing on Escape, the ×, and a tap on the wash', async () => {
    const v = view()
    await render(v)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    act(() => button('Close').click())
    act(() => (sheet().previousElementSibling as HTMLElement).click())
    expect(v.onDismiss).toHaveBeenCalledTimes(3)
    expect(v.onKeep).not.toHaveBeenCalled()
    expect(v.onStandard).not.toHaveBeenCalled()
  })

  it('offers both choices', async () => {
    const v = view()
    await render(v)
    act(() => button('keep original').click())
    act(() => button('standard while away').click())
    expect(v.onKeep).toHaveBeenCalledOnce()
    expect(v.onStandard).toHaveBeenCalledOnce()
  })

  it("is a history entry, so Android's back closes it, and a close by any other way leaves the entry", async () => {
    const v = view()
    const { draw } = await render(v)
    expect(onNoticeEntry()).toBe(true)
    const popped = new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true }))
    history.back()
    await act(async () => void (await popped))
    expect(v.onDismiss).toHaveBeenCalledOnce()

    // Open again, then closed by a choice: its entry goes.
    await draw(view({ open: false }))
    await draw(v)
    await frames()
    expect(onNoticeEntry()).toBe(true)
    const left = new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true }))
    await draw({ ...v, open: false })
    await act(async () => void (await left))
    expect(onNoticeEntry()).toBe(false)
  })

  it('rises from below the edge, and only fades under reduced motion', async () => {
    await render(view())
    expect(sheet().style.transform).toBe('')
    expect(sheet().className).toContain('transition-transform')
    act(() => roots.splice(0).forEach((root) => root.unmount()))
    document.body.innerHTML = ''
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined })),
    )
    await render(view())
    expect(sheet().className).toContain('transition-opacity')
    expect(sheet().className).not.toContain('transition-transform')
  })
})
