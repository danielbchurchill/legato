// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { pushSheetOverlay, useSheetOverlays, type SheetOverlay } from './navigation'
import { closePhoneNode, openPhoneNode } from './nodeDetail'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []
let seen: (readonly SheetOverlay[])[] = []

function Probe() {
  seen.push(useSheetOverlays())
  return null
}

function mount() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(createElement(Probe)))
}

async function popped() {
  await act(async () => {
    await new Promise<void>((resolve) => window.addEventListener('popstate', () => resolve(), { once: true }))
  })
}

beforeEach(() => {
  history.replaceState(null, '')
  seen = []
})

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()))
  document.body.innerHTML = ''
})

describe("opening a node's detail on the phone", () => {
  it('opens over the map, so back returns there', () => {
    mount()
    act(() => openPhoneNode(4))
    expect(seen.at(-1)).toEqual([{ kind: 'node', id: 4 }])
  })

  it('opens over search, so back returns there', () => {
    mount()
    act(() => pushSheetOverlay({ kind: 'search' }))
    act(() => openPhoneNode(4))
    expect(seen.at(-1)).toEqual([{ kind: 'search' }, { kind: 'node', id: 4 }])
  })

  it("takes the place of a node already showing, as another node's tap on the map does", () => {
    mount()
    act(() => openPhoneNode(4))
    const before = history.length
    act(() => openPhoneNode(5))
    expect(seen.at(-1)).toEqual([{ kind: 'node', id: 5 }])
    expect(history.length).toBe(before)
  })

  it('pushes over the node showing for a link inside its detail', () => {
    mount()
    act(() => openPhoneNode(4))
    act(() => openPhoneNode(9, { push: true }))
    expect(seen.at(-1)).toEqual([
      { kind: 'node', id: 4 },
      { kind: 'node', id: 9 },
    ])
  })

  it('goes back from a node, and says so', async () => {
    mount()
    act(() => openPhoneNode(4))
    act(() => openPhoneNode(9, { push: true }))
    const back = popped()
    let closed = false
    act(() => {
      closed = closePhoneNode()
    })
    await back
    expect(closed).toBe(true)
    expect(seen.at(-1)).toEqual([{ kind: 'node', id: 4 }])
  })

  it("closes nothing when no node's showing", () => {
    mount()
    act(() => pushSheetOverlay({ kind: 'search' }))
    const before = history.length
    expect(closePhoneNode()).toBe(false)
    expect(history.length).toBe(before)
  })
})
