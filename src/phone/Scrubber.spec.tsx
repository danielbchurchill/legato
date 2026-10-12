// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Scrubber } from './Scrubber'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []

beforeEach(() => {
  // The track runs from x 20 to 320.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 20, width: 300, top: 0, height: 44 } as DOMRect)
  HTMLElement.prototype.setPointerCapture = vi.fn()
})

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()))
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

function render(props: {
  positionMs?: number
  durationMs?: number | null
  onSeek?: (ms: number) => void
  onParentPointerDown?: () => void
}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() =>
    root.render(
      createElement(
        'div',
        { onPointerDown: props.onParentPointerDown },
        createElement(Scrubber, {
          positionMs: props.positionMs ?? 30_000,
          durationMs: props.durationMs === undefined ? 120_000 : props.durationMs,
          onSeek: props.onSeek ?? (() => undefined),
          middle: 'original',
        }),
      ),
    ),
  )
  const slider = container.querySelector<HTMLElement>('[role="slider"]')!
  const readouts = () => [...slider.nextElementSibling!.children].map((el) => el.textContent)
  return { container, slider, readouts }
}

function pointer(el: HTMLElement, type: string, clientX: number) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button: 0 })
  Object.defineProperty(event, 'pointerId', { value: 1 })
  Object.defineProperty(event, 'pointerType', { value: 'touch' })
  act(() => el.dispatchEvent(event))
}

describe('Scrubber', () => {
  it('shows elapsed, the middle and what is left', () => {
    const { readouts } = render({})
    expect(readouts()).toEqual(['0:30', 'original', '−1:30'])
  })

  it('follows the finger and seeks once, where it lets go', () => {
    const onSeek = vi.fn()
    const { slider, readouts } = render({ onSeek })
    pointer(slider, 'pointerdown', 50)
    pointer(slider, 'pointermove', 170)
    // Half way along a two-minute track, before anything has seeked.
    expect(readouts()[0]).toBe('1:00')
    expect(onSeek).not.toHaveBeenCalled()
    pointer(slider, 'pointermove', 230)
    pointer(slider, 'pointerup', 230)
    expect(onSeek).toHaveBeenCalledOnce()
    expect(onSeek).toHaveBeenCalledWith(84_000)
  })

  it("keeps a press to itself, so the sheet behind doesn't take it for a drag", () => {
    const onParentPointerDown = vi.fn()
    const { slider } = render({ onParentPointerDown })
    pointer(slider, 'pointerdown', 50)
    expect(onParentPointerDown).not.toHaveBeenCalled()
  })

  it('moves five seconds per arrow key', () => {
    const onSeek = vi.fn()
    const { slider } = render({ onSeek })
    act(() => slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
    act(() => slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })))
    expect(onSeek.mock.calls).toEqual([[35_000], [25_000]])
  })

  it("can't seek a track with no length", () => {
    const onSeek = vi.fn()
    const { slider, container } = render({ durationMs: null, onSeek })
    pointer(slider, 'pointerdown', 50)
    pointer(slider, 'pointerup', 50)
    expect(onSeek).not.toHaveBeenCalled()
    expect(slider.getAttribute('aria-disabled')).toBe('true')
    expect(slider.tabIndex).toBe(-1)
    // No thumb on an unknown length.
    expect(container.querySelector('.size-\\[12px\\]')).toBeNull()
  })

  it('is a 44px target around a 4px track, and steps rather than eases', () => {
    const { slider } = render({})
    expect(slider.className).toContain('h-[44px]')
    const fill = slider.querySelector<HTMLElement>('.bg-\\[image\\:var\\(--accent-fill\\)\\]')!
    expect(fill.style.width).toBe('25%')
    expect(fill.className).not.toContain('transition')
  })
})
