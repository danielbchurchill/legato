// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Capsule } from './Capsule'
import { ShellLayoutContext, computeShellLayout } from './layout'
import * as geometry from './capsuleGeometry'

const roots: Root[] = []

beforeEach(() => {
  // jsdom has no ResizeObserver; Tabs measures its thumb with one.
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
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

function renderCapsule(windowWidth: number) {
  const layout = computeShellLayout(windowWidth, 900, { leftOpen: true, rightOpen: true })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => {
    root.render(
      createElement(
        ShellLayoutContext.Provider,
        { value: layout },
        createElement(Capsule, { view: 'map', onViewChange: () => undefined, onOpenSearch: () => undefined, hidden: false }),
      ),
    )
  })
  const capsule = container.querySelector<HTMLElement>('[role="tablist"]')!.parentElement!
  const search = container.querySelector<HTMLElement>('[aria-label="Search artists, albums, tracks"]')!
  const tabs = [...container.querySelectorAll('[role="tab"]')]
  return { layout, capsule, search, tabs }
}

// #308: layout.ts picks what the capsule shows by adding up
// capsuleGeometry.ts's sizes, so the capsule has to be drawn at them.
describe('Capsule geometry', () => {
  const px = (n: number) => `${n}px`

  it('pads and spaces its parts by the sizes layout.ts adds up', () => {
    const { layout, capsule, search } = renderCapsule(1440)
    expect(capsule.style.left).toBe(px(layout.capsuleCx))
    expect(capsule.style.width).toBe(px(layout.capsuleWidth))
    expect(capsule.style.paddingLeft).toBe(px(geometry.CAPSULE_PADDING_LEFT))
    expect(capsule.style.paddingRight).toBe(px(geometry.CAPSULE_PADDING_RIGHT))
    expect(capsule.style.gap).toBe(px(geometry.CAPSULE_GAP))
    expect((search.previousElementSibling as HTMLElement).style.width).toBe(px(geometry.CAPSULE_DIVIDER_WIDTH))
    expect(search.style.gap).toBe(px(geometry.CAPSULE_SEARCH_GAP))
    expect(search.style.paddingRight).toBe(px(geometry.CAPSULE_SEARCH_PADDING_RIGHT))
    expect((search.firstElementChild as HTMLElement).style.width).toBe(px(geometry.CAPSULE_SEARCH_ICON_SIZE))
  })
})

// Words on screen: text outside the icons' markup and the screen-reader-only labels.
function visibleText(root: Element): string[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const words: string[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent!.trim()
    if (text && !node.parentElement!.closest('svg, .sr-only')) words.push(text)
  }
  return words
}

describe('Capsule as it narrows', () => {
  it('shows every word in a wide window', () => {
    const { capsule, search } = renderCapsule(1440)
    expect(visibleText(capsule).slice(0, 3)).toEqual(['map', 'library', 'Search artists, albums, tracks'])
    expect(search.querySelector('kbd')?.textContent).toMatch(/^(⌘|Ctrl )K$/)
  })

  it('keeps the switch labelled and the magnifier at the narrowest desktop window', () => {
    const { capsule, search } = renderCapsule(1100)
    expect(visibleText(capsule)).toEqual(['map', 'library'])
    expect(search.querySelector('kbd')).toBeNull()
  })

  it("comes down to the switch's icons, still named for screen readers, and the search button", () => {
    const { capsule, tabs, search } = renderCapsule(900)
    expect(visibleText(capsule)).toEqual([])
    expect(tabs.map((t) => t.querySelector('.sr-only')?.textContent)).toEqual(['map', 'library'])
    expect(search.getAttribute('aria-label')).toBe('Search artists, albums, tracks')
  })
})
