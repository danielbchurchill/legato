// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { popPhonePage, pushPhonePage, usePhonePages, type PhonePage } from './navigation'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []
let seen: (readonly PhonePage[])[] = []

function Probe() {
  seen.push(usePhonePages())
  return null
}

function mount() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(createElement(Probe)))
}

/* jsdom fires popstate for history.back() on a later task, as a browser
 * does; this waits for it. */
async function popped() {
  await act(async () => {
    await new Promise<void>((resolve) => window.addEventListener('popstate', () => resolve(), { once: true }))
  })
}

beforeEach(() => {
  history.replaceState(null, '')
  seen = []
})

afterEach(async () => {
  act(() => roots.splice(0).forEach((root) => root.unmount()))
  document.body.innerHTML = ''
})

describe('phone navigation', () => {
  it('starts on the map, with nothing pushed', () => {
    mount()
    expect(seen.at(-1)).toEqual([])
  })

  it('pushes a page onto the history, carrying the whole stack', () => {
    mount()
    const before = history.length
    act(() => pushPhonePage('settings'))
    act(() => pushPhonePage('health'))
    expect(seen.at(-1)).toEqual(['settings', 'health'])
    expect(history.length).toBe(before + 2)
    expect((history.state as { legatoPhonePages: PhonePage[] }).legatoPhonePages).toEqual(['settings', 'health'])
  })

  it("doesn't push the page that's already on top", () => {
    mount()
    const before = history.length
    act(() => pushPhonePage('settings'))
    act(() => pushPhonePage('settings'))
    expect(seen.at(-1)).toEqual(['settings'])
    expect(history.length).toBe(before + 1)
  })

  it("keeps whatever else is in the history entry's state", () => {
    history.replaceState({ other: 1 }, '')
    mount()
    act(() => pushPhonePage('settings'))
    expect(history.state).toMatchObject({ other: 1, legatoPhonePages: ['settings'] })
  })

  it("pops a page with the system's back, as Android's gesture and the browser's button do", async () => {
    mount()
    act(() => pushPhonePage('settings'))
    act(() => pushPhonePage('health'))
    const back = popped()
    history.back()
    await back
    expect(seen.at(-1)).toEqual(['settings'])
  })

  it("pops a page with the page's own back, through the history", async () => {
    mount()
    act(() => pushPhonePage('settings'))
    const back = popped()
    popPhonePage()
    await back
    expect(seen.at(-1)).toEqual([])
  })

  it('does nothing on the map, rather than leaving the app', () => {
    mount()
    const before = history.length
    const pages = seen.at(-1)
    popPhonePage()
    expect(history.length).toBe(before)
    expect(seen.at(-1)).toBe(pages)
  })

  it('reads a stack already in the history, as after a reload on a page', () => {
    history.replaceState({ legatoPhonePages: ['settings', 'nonsense', 'health'] }, '')
    mount()
    expect(seen.at(-1)).toEqual(['settings', 'health'])
  })
})
