// @vitest-environment jsdom
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sheet } from './Sheet'
import type { Detent } from './sheetGeometry'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []

beforeEach(() => {
  // jsdom lays nothing out: no ResizeObserver, and every box is 0 tall.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })),
  )
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(844)
})

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()))
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

function renderSheet(initial: Detent = 'peek') {
  const changes: Detent[] = []
  let mounts = 0
  function Content() {
    mounts++
    return <p>the content</p>
  }
  function Harness() {
    const [detent, setDetent] = useState<Detent>(initial)
    return (
      <Sheet
        label="Library and player"
        detent={detent}
        onDetentChange={(next) => {
          changes.push(next)
          setDetent(next)
        }}
        header={<div>the header</div>}
        peek={<div>the peek line</div>}
      >
        <Content />
      </Sheet>
    )
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(createElement(Harness)))
  return {
    container,
    changes,
    mounts: () => mounts,
    handle: () => container.querySelector<HTMLButtonElement>('section > div > button')!,
    sheet: () => container.querySelector<HTMLElement>('section')!,
  }
}

describe('Sheet', () => {
  it('names the sheet, and the handle after it with the detent it is at', () => {
    const { sheet, handle } = renderSheet()
    expect(sheet().getAttribute('aria-label')).toBe('Library and player')
    expect(handle().getAttribute('aria-label')).toBe('Library and player, collapsed')
  })

  it('steps through the detents from the handle, for a keyboard or a screen reader', () => {
    const { handle, changes } = renderSheet()
    act(() => handle().click())
    expect(handle().getAttribute('aria-label')).toBe('Library and player, half height')
    act(() => handle().click())
    expect(handle().getAttribute('aria-label')).toBe('Library and player, full height')
    act(() => handle().click())
    expect(changes).toEqual(['medium', 'large', 'peek'])
  })

  it('waits to mount the content until the sheet first leaves peek, then keeps it', () => {
    const { container, handle, mounts } = renderSheet()
    expect(container.textContent).not.toContain('the content')
    act(() => handle().click())
    expect(container.textContent).toContain('the content')
    act(() => handle().click())
    act(() => handle().click())
    expect(container.textContent).toContain('the content')
    expect(mounts()).toBeGreaterThan(0)
  })

  it('shows the peek line at peek and takes the content out of reach, and the other way round above it', () => {
    const { container, handle } = renderSheet()
    const peek = () => container.querySelector<HTMLElement>('section .absolute.inset-x-0.top-0')!
    const body = () => container.querySelector<HTMLElement>('.overflow-y-auto')!
    expect(peek().getAttribute('aria-hidden')).toBe('false')
    expect(body().hasAttribute('inert')).toBe(true)
    act(() => handle().click())
    expect(peek().getAttribute('aria-hidden')).toBe('true')
    expect(body().hasAttribute('inert')).toBe(false)
  })

  it('places the sheet at its large height and slides it down to the detent', () => {
    const { sheet } = renderSheet('large')
    // 844 tall with no safe areas: large leaves 64px of map at the top.
    expect(sheet().style.height).toBe('780px')
    expect(sheet().style.transform).toBe('translate3d(0, 0px, 0)')
  })

  it('says what a drag started on, so the mini player dragged up can open up next', () => {
    HTMLElement.prototype.setPointerCapture = vi.fn()
    const asked: { detent: Detent; origin: Element | null | undefined }[] = []
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    act(() =>
      root.render(
        <Sheet
          label="Library and player"
          detent="peek"
          onDetentChange={(detent, origin) => asked.push({ detent, origin })}
          header={<p data-mini>the mini player</p>}
          wash="linear-gradient(red, transparent)"
        >
          <p>the content</p>
        </Sheet>,
      ),
    )
    const mini = container.querySelector('[data-mini]')!
    const handle = container.querySelector<HTMLButtonElement>('section > div > button')!
    const drag = (from: Element) => {
      for (const [type, y] of [
        ['pointerdown', 800],
        ['pointermove', 700],
        ['pointermove', 500],
        ['pointerup', 500],
      ] as const) {
        const event = new MouseEvent(type, { bubbles: true, clientX: 195, clientY: y, button: 0 })
        Object.defineProperty(event, 'pointerId', { value: 1 })
        act(() => from.dispatchEvent(event))
      }
    }
    drag(mini)
    expect(asked).toEqual([{ detent: 'medium', origin: mini }])

    // The handle's target lies over the top of the header: a drag that
    // starts on it started on what it covers.
    document.elementsFromPoint = () => [handle, mini, container]
    drag(handle)
    expect(asked[1].origin).toBe(mini)
  })

  it('draws a wash over the glass from its top edge, under everything in it', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    act(() =>
      root.render(
        <Sheet
          label="Library and player"
          detent="large"
          onDetentChange={() => undefined}
          header={null}
          wash="linear-gradient(red, transparent)"
        >
          <p>the content</p>
        </Sheet>,
      ),
    )
    const wash = container.querySelector<HTMLElement>('section')!.firstElementChild as HTMLElement
    expect(wash.style.background).toContain('linear-gradient')
    expect(wash.className).toContain('pointer-events-none')
  })

  it('lets a tap on the dim at large go back to the map', () => {
    const { container, changes } = renderSheet('large')
    const dim = container.querySelector<HTMLElement>('[aria-hidden="true"].absolute.inset-0')!
    expect(dim.style.pointerEvents).toBe('auto')
    act(() => dim.click())
    expect(changes).toEqual(['peek'])
  })
})

describe('Sheet, showing a view over its content', () => {
  function renderOverlay({ overlay, dim = true, largeTopGap }: { overlay?: string; dim?: boolean; largeTopGap?: number }) {
    function Harness() {
      return (
        <Sheet
          label="Search results"
          detent="large"
          onDetentChange={() => undefined}
          header={null}
          overlay={overlay != null ? <p>{overlay}</p> : undefined}
          overlayKey={overlay}
          dim={dim}
          largeTopGap={largeTopGap}
        >
          <p>the tab</p>
        </Sheet>
      )
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    act(() => root.render(createElement(Harness)))
    return container
  }

  it('draws the overlay over the content, which stays mounted out of reach', () => {
    const container = renderOverlay({ overlay: 'the results' })
    const [body, overlay] = container.querySelectorAll<HTMLElement>('.overflow-y-auto')
    expect(body.textContent).toBe('the tab')
    expect(body.hasAttribute('inert')).toBe(true)
    expect(body.style.visibility).toBe('hidden')
    expect(overlay.textContent).toBe('the results')
    expect(overlay.hasAttribute('inert')).toBe(false)
  })

  it('gives the content back with no overlay', () => {
    const container = renderOverlay({})
    const scrollers = container.querySelectorAll<HTMLElement>('.overflow-y-auto')
    expect(scrollers).toHaveLength(1)
    expect(scrollers[0].hasAttribute('inert')).toBe(false)
    expect(scrollers[0].style.visibility).toBe('')
  })

  it("leaves search's 70px of map at large, and doesn't dim it", () => {
    const container = renderOverlay({ overlay: 'the results', dim: false, largeTopGap: 70 })
    expect(container.querySelector<HTMLElement>('section')!.style.height).toBe('774px')
    const dim = container.querySelector<HTMLElement>('[aria-hidden="true"].absolute.inset-0')!
    expect(dim.style.opacity).toBe('0')
    expect(dim.style.pointerEvents).toBe('none')
  })
})
