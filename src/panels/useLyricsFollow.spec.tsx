// @vitest-environment jsdom
//
// #445: the sung line landed on the bottom edge of the lyrics, under the
// phone's fade, because scrollIntoView's "nearest" only scrolls until a
// line is just in view. These tests lay out 40 lines 30px tall in a 300px
// scroller (jsdom does no layout, so the geometry is stubbed) and check
// where the follow puts the sung line, and that a reader who scrolls away
// is left alone until they come back or RESUME_MS passes.
import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readingScrollTop, RESUME_MS, useLyricsFollow } from './useLyricsFollow'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const LINE = 30
const VIEW = 300
const COUNT = 40
const LINES = Array.from({ length: COUNT }, (_, i) => `line ${i}`)

/** Where line `i`'s middle sits a third of the way down: 300 / 3 = 100px. */
const reading = (i: number) => i * LINE + LINE / 2 - VIEW / 3

let reduced = false
let scroller: HTMLDivElement
const scrolls: ScrollToOptions[] = []

function Harness({ current, lines }: { current: number; lines: unknown }) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const line = useRef<HTMLSpanElement>(null)
  const { tail } = useLyricsFollow({ scroller: scrollerRef, line, current, lines })
  return (
    <div ref={scrollerRef} data-scroller="">
      {LINES.map((text, i) => (
        <span key={i} data-line={i} ref={i === current ? line : undefined}>
          {text}
        </span>
      ))}
      <span data-tail="" style={{ height: tail }} />
    </div>
  )
}

const roots: Root[] = []

function render(current: number, lines: unknown = LINES) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(<Harness current={current} lines={lines} />))
  scroller = container.querySelector('[data-scroller]') as HTMLDivElement
  return (next: number, nextLines: unknown = lines) => act(() => root.render(<Harness current={next} lines={nextLines} />))
}

/** The reader scrolling, as the browser reports it: no scrollTo of ours. */
function readerScrollsTo(top: number) {
  act(() => {
    scroller.scrollTop = top
    scroller.dispatchEvent(new Event('scroll'))
  })
}

beforeEach(() => {
  reduced = false
  scrolls.length = 0
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: reduced, addEventListener: () => undefined, removeEventListener: () => undefined })),
  )
  // Reports the size an element starts with on observe, as a browser's does.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      callback: () => void
      constructor(callback: () => void) {
        this.callback = callback
      }
      observe() {
        this.callback()
      }
      disconnect() {}
    },
  )
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.dataset.scroller != null ? VIEW : 0
  })
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
    const tail = this.querySelector<HTMLElement>('[data-tail]')
    return COUNT * LINE + (tail ? parseFloat(tail.style.height) || 0 : 0)
  })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.dataset.line != null ? LINE : 0
  })
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const el = this as HTMLElement
    const scrolledBy = el.closest<HTMLElement>('[data-scroller]')?.scrollTop ?? 0
    const top = el.dataset.line != null ? Number(el.dataset.line) * LINE - scrolledBy : 0
    return { top, bottom: top + LINE, left: 0, right: 0, width: 0, height: LINE, x: 0, y: top, toJSON: () => ({}) } as DOMRect
  })
  // A smooth scroll reports a step on its way, then its arrival, as a
  // browser's does; an instant one only arrives.
  ;(HTMLElement.prototype as { scrollTo: (options: ScrollToOptions) => void }).scrollTo = function (
    this: HTMLElement,
    options: ScrollToOptions,
  ) {
    scrolls.push(options)
    const to = options.top ?? 0
    if (options.behavior === 'smooth') {
      this.scrollTop = (this.scrollTop + to) / 2
      this.dispatchEvent(new Event('scroll'))
    }
    this.scrollTop = to
    this.dispatchEvent(new Event('scroll'))
  }
})

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()))
  delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('readingScrollTop', () => {
  it("puts the line's middle a third of the way down", () => {
    expect(readingScrollTop(300, 30, 300, 2000)).toBe(215)
  })

  it('stops at the ends of what can scroll', () => {
    expect(readingScrollTop(30, 30, 300, 2000)).toBe(0)
    expect(readingScrollTop(1950, 30, 300, 2000)).toBe(1700)
  })
})

describe('useLyricsFollow', () => {
  it('opens on the sung line, at the reading position, without a glide', () => {
    render(20)
    expect(scroller.scrollTop).toBe(reading(20))
    expect(scrolls.at(-1)?.behavior).toBe('auto')
  })

  it('glides each new line to the reading position', () => {
    const play = render(10)
    play(11)
    expect(scroller.scrollTop).toBe(reading(11))
    expect(scrolls.at(-1)).toEqual({ top: reading(11), behavior: 'smooth' })
    play(12)
    expect(scroller.scrollTop).toBe(reading(12))
  })

  it('leaves the first lines where they start, at the top', () => {
    const play = render(-1)
    expect(scroller.scrollTop).toBe(0)
    play(1)
    expect(scroller.scrollTop).toBe(0)
  })

  it('leaves room after the last line for it to reach the reading position', () => {
    render(COUNT - 1)
    const tail = scroller.querySelector<HTMLElement>('[data-tail]')!
    expect(tail.style.height).toBe(`${Math.round((VIEW * 2) / 3)}px`)
    expect(scroller.scrollTop).toBe(reading(COUNT - 1))
  })

  it('jumps rather than glides under reduced motion', () => {
    reduced = true
    const play = render(10)
    play(11)
    expect(scrolls.at(-1)).toEqual({ top: reading(11), behavior: 'auto' })
    expect(scroller.scrollTop).toBe(reading(11))
  })

  it("doesn't pull back a reader who scrolled ahead", () => {
    vi.useFakeTimers()
    const play = render(10)
    readerScrollsTo(800)
    const before = scrolls.length
    play(11)
    play(12)
    expect(scroller.scrollTop).toBe(800)
    expect(scrolls).toHaveLength(before)
  })

  it('picks the follow up again a few seconds after the reader stops scrolling', () => {
    vi.useFakeTimers()
    const play = render(10)
    readerScrollsTo(700)
    act(() => vi.advanceTimersByTime(RESUME_MS / 2))
    readerScrollsTo(800)
    play(11)
    act(() => vi.advanceTimersByTime(RESUME_MS - 1))
    expect(scroller.scrollTop).toBe(800)
    act(() => vi.advanceTimersByTime(1))
    expect(scroller.scrollTop).toBe(reading(11))
    play(12)
    expect(scroller.scrollTop).toBe(reading(12))
  })

  it('picks the follow up again as soon as the reader scrolls back to the sung line', () => {
    vi.useFakeTimers()
    const play = render(10)
    readerScrollsTo(800)
    play(11)
    // Back within a few lines of where line 11 belongs.
    readerScrollsTo(reading(11) + 20)
    act(() => vi.advanceTimersByTime(200))
    play(12)
    expect(scroller.scrollTop).toBe(reading(12))
  })

  it('stays away while the reader is still a long way from the sung line', () => {
    vi.useFakeTimers()
    const play = render(10)
    readerScrollsTo(800)
    act(() => vi.advanceTimersByTime(200))
    play(11)
    expect(scroller.scrollTop).toBe(800)
  })

  it("follows a new song's lyrics at once, whatever the reader was doing", () => {
    vi.useFakeTimers()
    const play = render(10)
    readerScrollsTo(800)
    play(5, [...LINES])
    expect(scroller.scrollTop).toBe(reading(5))
  })

  it('does nothing with nothing to follow', () => {
    render(10, null)
    expect(scrolls).toEqual([])
    expect(scroller.querySelector<HTMLElement>('[data-tail]')!.style.height).toBe('0px')
  })
})
