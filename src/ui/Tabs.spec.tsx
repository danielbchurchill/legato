// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Tabs, type TabOption } from './Tabs'

const VIEWS: TabOption<'map' | 'library'>[] = [
  { value: 'map', label: 'map', icon: 'map' },
  { value: 'library', label: 'library', icon: 'library' },
]

const roots: Root[] = []

beforeEach(() => {
  // jsdom has no ResizeObserver; Tabs measures its indicator with one, and a tooltip its place.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  // Nor matchMedia, which Tabs asks about reduced motion.
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })),
  )
})

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()))
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

function renderTabs(props: Partial<Parameters<typeof Tabs<'map' | 'library'>>[0]> = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  const render = (next: typeof props = {}) =>
    act(() => root.render(<Tabs label="view" size="lg" options={VIEWS} value="map" onChange={() => undefined} {...props} {...next} />))
  render()
  const list = container.querySelector<HTMLElement>('[role="tablist"]')!
  return { list, render, tabs: () => [...list.querySelectorAll<HTMLElement>('[role="tab"]')] }
}

const nextFrame = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))

// Words on screen, without the screen-reader-only labels.
const visibleText = (el: Element) =>
  [...el.querySelectorAll('[role="tab"]')].map((tab) =>
    [...tab.childNodes]
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent)
      .join(''),
  )

describe('Tabs indicator', () => {
  const sliding = (list: HTMLElement) => list.firstElementChild!.className.includes('transition-[transform,width]')

  it('slides to a new tab, but jumps when the tabs change shape (#308)', async () => {
    const { list, render } = renderTabs()
    // The first placement doesn't slide in from nowhere.
    expect(sliding(list)).toBe(false)
    await nextFrame()
    expect(sliding(list)).toBe(true)

    // Dropping the labels resizes every tab at once: a slide from the old box would draw the
    // indicator outside the narrower switch, so it jumps.
    render({ iconOnly: true })
    expect(sliding(list)).toBe(false)
    await nextFrame()
    expect(sliding(list)).toBe(true)

    // A change of tab after that still slides.
    render({ iconOnly: true, value: 'library' })
    expect(sliding(list)).toBe(true)
  })
})

describe('Tabs with iconOnly', () => {
  it('draws each icon alone, its label kept for screen readers and in a tooltip that shows only then', () => {
    vi.useFakeTimers()
    const { list, render, tabs } = renderTabs()
    const hover = (tab: HTMLElement) => {
      act(() => tab.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })))
      act(() => vi.advanceTimersByTime(400))
    }
    const tooltip = () => document.querySelector('[role="tooltip"]')?.textContent ?? null
    const leave = (tab: HTMLElement) => act(() => tab.dispatchEvent(new MouseEvent('pointerout', { bubbles: true })))

    // Labelled, a tab says its name already.
    hover(tabs()[0])
    expect(tooltip()).toBeNull()
    leave(tabs()[0])

    const [map] = tabs()
    render({ iconOnly: true })
    expect(visibleText(list)).toEqual(['', ''])
    expect(tabs().map((t) => t.querySelector('.sr-only')?.textContent)).toEqual(['map', 'library'])
    // The same element, so a keyboard user's focus stays on it as the switch changes shape.
    expect(tabs()[0]).toBe(map)
    hover(tabs()[1])
    expect(tooltip()).toBe('library')
  })

  it('keeps focus on the tab as the labels come and go', () => {
    const { render, tabs } = renderTabs()
    act(() => tabs()[0].focus())
    render({ iconOnly: true })
    expect(document.activeElement).toBe(tabs()[0])
    render({ iconOnly: false })
    expect(document.activeElement).toBe(tabs()[0])
  })

  it('never draws a blank tab: an option without an icon keeps its label', () => {
    const plain: TabOption<'map' | 'library'>[] = VIEWS.map(({ value, label }) => ({ value, label }))
    const segmented = renderTabs({ options: plain, iconOnly: true })
    expect(visibleText(segmented.list)).toEqual(['map', 'library'])

    const underline = renderTabs({ variant: 'underline', iconOnly: true })
    expect(visibleText(underline.list)).toEqual(['map', 'library'])
    expect(underline.list.querySelector('.sr-only')).toBeNull()
  })

  it("at the phone's size, shares the width equally in 40px segments, each option's swatch before its label", () => {
    const options: TabOption<'map' | 'library'>[] = [
      { value: 'map', label: 'map', swatch: '#0f1214' },
      { value: 'library', label: 'library' },
    ]
    const { list, tabs } = renderTabs({ size: 'xl', options })
    expect(list.className).toContain('grid')
    expect(list.className).toContain('auto-cols-fr')
    expect(tabs().every((tab) => tab.className.includes('h-[40px]') && tab.className.includes('touch-target'))).toBe(true)
    const [swatch] = tabs()[0].querySelectorAll<HTMLElement>('[aria-hidden="true"]')
    expect(swatch.style.background).toBe('rgb(15, 18, 20)')
    expect(tabs()[1].querySelector('[aria-hidden="true"]')).toBeNull()
    expect(visibleText(list)).toEqual(['map', 'library'])
  })

  it("underlined at md, draws the phone node detail's 14/500 tabs, 22px apart", () => {
    const { list, tabs } = renderTabs({ variant: 'underline', size: 'md' })
    expect(list.className).toContain('gap-[22px]')
    expect(
      tabs().every(
        (tab) =>
          tab.className.includes('text-[length:var(--text-body)]') &&
          tab.className.includes('py-[10px]') &&
          tab.className.includes('touch-target'),
      ),
    ).toBe(true)
    // The 2px ink rule, not a raised segment.
    expect(list.firstElementChild!.className).toContain('h-[2px]')
  })
})
