// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RepeatMode, usePlayback } from '../playback/usePlayback'
import { Transport } from './Transport'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Playback = ReturnType<typeof usePlayback>

const roots: Root[] = []

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()))
  document.body.innerHTML = ''
})

function fakePlayback(patch: Partial<Playback> = {}, playing = true): Playback {
  return {
    status: { playing, positionMs: 0, currentRecordingNodeId: 7, currentFileId: 70, currentDurationMs: 1000, streaming: false, volume: 1 },
    shuffled: false,
    queueBusy: false,
    problem: null,
    toggleShuffle: vi.fn(),
    previous: vi.fn(),
    next: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    resolveProblem: vi.fn(),
    ...patch,
  } as unknown as Playback
}

function render(playback: Playback, size: 'sheet' | 'full', repeatMode: RepeatMode = 'off', onCycleRepeat = vi.fn()) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(createElement(Transport, { playback, size, repeatMode, onCycleRepeat })))
  const button = (name: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!
  const width = (name: string) => button(name).style.width
  return { container, button, width }
}

describe('Transport', () => {
  it("draws up next's 44 / 52 / 64 / 52 / 44 and Now playing's 48 / 56 / 76 / 56 / 48", () => {
    const sheet = render(fakePlayback(), 'sheet')
    expect(['Shuffle off', 'Previous track', 'Pause', 'Next track', 'Repeat off'].map(sheet.width)).toEqual([
      '44px',
      '52px',
      '64px',
      '52px',
      '44px',
    ])
    const full = render(fakePlayback(), 'full')
    expect(['Shuffle off', 'Previous track', 'Pause', 'Next track', 'Repeat off'].map(full.width)).toEqual([
      '48px',
      '56px',
      '76px',
      '56px',
      '48px',
    ])
  })

  it('drives the same playback as every other player', () => {
    const playback = fakePlayback()
    const { button } = render(playback, 'sheet')
    act(() => button('Shuffle off').click())
    act(() => button('Previous track').click())
    act(() => button('Pause').click())
    act(() => button('Next track').click())
    expect(playback.toggleShuffle).toHaveBeenCalledOnce()
    expect(playback.previous).toHaveBeenCalledOnce()
    expect(playback.pause).toHaveBeenCalledOnce()
    expect(playback.next).toHaveBeenCalledOnce()

    const paused = fakePlayback({}, false)
    const second = render(paused, 'full')
    act(() => second.button('Play').click())
    expect(paused.resume).toHaveBeenCalledOnce()
  })

  it('turns shuffle the accent, pressed, while it is on', () => {
    const { button } = render(fakePlayback({ shuffled: true }), 'sheet')
    expect(button('Shuffle on').getAttribute('aria-pressed')).toBe('true')
    expect(button('Shuffle on').className).toContain('text-[var(--color-accent)]')
  })

  it('cycles repeat, in the accent while on, with a 1 for repeat-one', () => {
    const onCycleRepeat = vi.fn()
    const off = render(fakePlayback(), 'sheet', 'off', onCycleRepeat)
    expect(off.button('Repeat off').className).toContain('text-[var(--color-ink-2)]')
    act(() => off.button('Repeat off').click())
    expect(onCycleRepeat).toHaveBeenCalledOnce()

    const all = render(fakePlayback(), 'sheet', 'all')
    expect(all.button('Repeat all tracks').className).toContain('text-[var(--color-accent)]')
    expect(all.button('Repeat all tracks').parentElement!.textContent!.trim()).toBe('')

    const one = render(fakePlayback(), 'sheet', 'one')
    expect(one.button('Repeat current track').parentElement!.textContent!.trim()).toBe('1')
  })

  it('turns play into the fix for a track that would not start', () => {
    const playback = fakePlayback(
      { problem: { headline: "Can't find this file", detail: 'The drive is unplugged', action: 'retry' } as Playback['problem'] },
      false,
    )
    const { button } = render(playback, 'full')
    act(() => button('Try again').click())
    expect(playback.resolveProblem).toHaveBeenCalledOnce()
  })

  it('holds every control while the queue is busy', () => {
    const { container } = render(fakePlayback({ queueBusy: true }), 'sheet')
    expect([...container.querySelectorAll('button')].every((b) => b.disabled)).toBe(true)
  })
})
