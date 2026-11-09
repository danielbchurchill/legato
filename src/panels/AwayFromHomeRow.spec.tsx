// @vitest-environment jsdom
// Issue #412: Away from home in the desktop browser's Settings.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })),
  )
  // The select's list measures itself and scrolls its option into view.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  Element.prototype.scrollIntoView = () => {}
})

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()))
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

// A fresh module graph per test, so the store reads this test's storage.
async function render() {
  vi.resetModules()
  const { AwayFromHomeRow } = await import('./AwayFromHomeRow')
  const { awayFromHome } = await import('../connect/awayFromHome')
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(createElement(AwayFromHomeRow)))
  return { container, awayFromHome, select: () => container.querySelector<HTMLButtonElement>('[role="combobox"]')! }
}

describe('AwayFromHomeRow', () => {
  it('is a row named Away from home with a select named away from home, and its note under it', async () => {
    const { container, select } = await render()
    expect(container.textContent).toContain('Away from home')
    expect(select().getAttribute('aria-label')).toBe('away from home')
    expect(select().textContent).toContain('tell me')
    const note = container.querySelector('p')!
    expect(note.textContent).toBe('When your server sees this device reach it over Tailscale from outside your home network.')
    expect(note.className).toContain('text-small')
    expect(note.className).toContain('text-[var(--color-ink-3)]')
  })

  it('offers tell me, standard · 160 kbps and same as home, and keeps the pick on this device', async () => {
    const { container, select, awayFromHome } = await render()
    act(() => select().click())
    const options = [...container.ownerDocument.querySelectorAll<HTMLElement>('[role="option"]')]
    expect(options.map((o) => o.textContent?.trim())).toEqual(['tell me', 'standard · 160 kbps', 'same as home'])
    act(() => options[1]!.click())
    expect(localStorage.getItem('legato:away-quality')).toBe('standard')
    expect(awayFromHome.snapshot().quality).toBe('standard')
    expect(select().textContent).toContain('standard · 160 kbps')
  })

  it('shows what the notice chose, and what this device already had', async () => {
    localStorage.setItem('legato:away-quality', 'same')
    const { select, awayFromHome } = await render()
    expect(select().textContent).toContain('same as home')
    act(() => awayFromHome.setQuality('standard'))
    expect(select().textContent).toContain('standard · 160 kbps')
  })
})
