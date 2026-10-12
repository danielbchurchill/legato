// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  closePhonePages,
  closeSheetView,
  currentSheetOverlays,
  openSheetView,
  popPhonePage,
  popSheetOverlay,
  pushPhonePage,
  pushSheetOverlay,
  replaceOverlaysWithView,
  replaceSheetOverlay,
  usePhonePages,
  useSheetOverlays,
  useSheetView,
  type PhonePage,
  type SheetOverlay,
  type SheetView,
} from './navigation'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []
let seen: (readonly PhonePage[])[] = []
let views: (SheetView | null)[] = []

function Probe() {
  seen.push(usePhonePages())
  views.push(useSheetView())
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
  views = []
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

  it("keeps Library health's lists on the stack, and drops a list that doesn't exist", () => {
    history.replaceState({ legatoPhonePages: ['settings', 'health', 'worklist:duplicates', 'worklist:nonsense'] }, '')
    mount()
    expect(seen.at(-1)).toEqual(['settings', 'health', 'worklist:duplicates'])
  })

  it('closes every page at once, back to the map', async () => {
    mount()
    act(() => pushPhonePage('settings'))
    act(() => pushPhonePage('health'))
    act(() => pushPhonePage('worklist:missing'))
    const back = popped()
    closePhonePages()
    await back
    expect(seen.at(-1)).toEqual([])
  })

  it('closes nothing on the map', () => {
    mount()
    const before = history.length
    closePhonePages()
    expect(history.length).toBe(before)
  })
})

describe('a view in the sheet', () => {
  // Each starts from a marked entry, the tab, so a back can be seen to land
  // on it. (history.length would count entries earlier tests left ahead.)
  it('opens as a history entry, which the system back leaves', async () => {
    history.replaceState({ tab: true }, '')
    mount()
    act(() => openSheetView({ kind: 'favourites' }))
    expect(views.at(-1)).toEqual({ kind: 'favourites' })
    expect(history.state).toEqual({ tab: true, legatoSheetView: { kind: 'favourites' } })
    const back = popped()
    history.back()
    await back
    expect(history.state).toEqual({ tab: true })
    expect(views.at(-1)).toBeNull()
  })

  it('replaces the open view rather than stacking, so one back lands on the tab', async () => {
    history.replaceState({ tab: true }, '')
    mount()
    act(() => openSheetView({ kind: 'import' }))
    act(() => openSheetView({ kind: 'playlist', playlistId: 7 }))
    expect(views.at(-1)).toEqual({ kind: 'playlist', playlistId: 7 })
    const back = popped()
    closeSheetView()
    await back
    expect(history.state).toEqual({ tab: true })
    expect(views.at(-1)).toBeNull()
  })

  it('comes back under a page pushed over it', async () => {
    mount()
    act(() => openSheetView({ kind: 'playlist', playlistId: 3 }))
    act(() => pushPhonePage('settings'))
    expect(history.state).toMatchObject({ legatoSheetView: { kind: 'playlist', playlistId: 3 }, legatoPhonePages: ['settings'] })
    const back = popped()
    popPhonePage()
    await back
    expect(seen.at(-1)).toEqual([])
    expect(views.at(-1)).toEqual({ kind: 'playlist', playlistId: 3 })
  })

  it('does nothing with no view open', () => {
    mount()
    const before = history.length
    closeSheetView()
    expect(history.length).toBe(before)
  })

  it("reads a view already in the history, and ignores one it doesn't know", () => {
    history.replaceState({ legatoSheetView: { kind: 'playlist', playlistId: 4 } }, '')
    mount()
    expect(views.at(-1)).toEqual({ kind: 'playlist', playlistId: 4 })
    act(() => roots.splice(0).forEach((root) => root.unmount()))
    history.replaceState({ legatoSheetView: { kind: 'playlist', playlistId: 'x' } }, '')
    mount()
    expect(views.at(-1)).toBeNull()
  })
})

describe("the sheet's overlays", () => {
  let overlays: (readonly SheetOverlay[])[] = []

  function OverlaysProbe() {
    overlays.push(useSheetOverlays())
    seen.push(usePhonePages())
    return null
  }

  function mountOverlays() {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    act(() => root.render(createElement(OverlaysProbe)))
  }

  beforeEach(() => {
    overlays = []
  })

  it('starts on the tabs, with no overlay', () => {
    mountOverlays()
    expect(overlays.at(-1)).toEqual([])
  })

  it('pushes an overlay onto the history beside the pages, and back pops it', async () => {
    mountOverlays()
    act(() => pushSheetOverlay({ kind: 'search' }))
    act(() => pushSheetOverlay({ kind: 'node', id: 4 }))
    expect(overlays.at(-1)).toEqual([{ kind: 'search' }, { kind: 'node', id: 4 }])
    expect(history.state).toMatchObject({ legatoPhonePages: [], legatoSheetOverlays: [{ kind: 'search' }, { kind: 'node', id: 4 }] })
    const back = popped()
    popSheetOverlay()
    await back
    expect(overlays.at(-1)).toEqual([{ kind: 'search' }])
  })

  it("doesn't push the overlay that's already on top", () => {
    mountOverlays()
    act(() => pushSheetOverlay({ kind: 'node', id: 4 }))
    const once = history.length
    act(() => pushSheetOverlay({ kind: 'node', id: 4 }))
    expect(history.length).toBe(once)
    expect(currentSheetOverlays()).toEqual([{ kind: 'node', id: 4 }])
  })

  it('replaces the overlay on top without a new history entry', () => {
    mountOverlays()
    act(() => pushSheetOverlay({ kind: 'node', id: 4 }))
    const before = history.length
    act(() => replaceSheetOverlay({ kind: 'node', id: 5 }))
    expect(history.length).toBe(before)
    expect(overlays.at(-1)).toEqual([{ kind: 'node', id: 5 }])
  })

  it('keeps the overlays when a page is pushed over them, and the pages when an overlay is', () => {
    mountOverlays()
    act(() => pushSheetOverlay({ kind: 'node', id: 4 }))
    act(() => pushPhonePage('settings'))
    expect(history.state).toMatchObject({ legatoPhonePages: ['settings'], legatoSheetOverlays: [{ kind: 'node', id: 4 }] })
    expect(overlays.at(-1)).toEqual([{ kind: 'node', id: 4 }])
    expect(seen.at(-1)).toEqual(['settings'])
  })

  it('does nothing with no overlay, rather than leaving the app', () => {
    mountOverlays()
    const before = history.length
    popSheetOverlay()
    expect(history.length).toBe(before)
  })

  it("leaves the overlays for a view in one step, so back from it goes where the overlay's back would", async () => {
    history.replaceState({ tab: true }, '')
    mount()
    mountOverlays()
    act(() => pushSheetOverlay({ kind: 'search' }))
    act(() => replaceOverlaysWithView({ kind: 'playlist', playlistId: 7 }))
    expect(overlays.at(-1)).toEqual([])
    expect(views.at(-1)).toEqual({ kind: 'playlist', playlistId: 7 })
    const back = popped()
    closeSheetView()
    await back
    expect(history.state).toEqual({ tab: true })
    expect(views.at(-1)).toBeNull()
  })

  it('reads the overlays already in the history, as after a reload, dropping anything else', () => {
    history.replaceState({ legatoSheetOverlays: [{ kind: 'search' }, { kind: 'node', id: 'x' }, { kind: 'node', id: 9 }, 'nonsense'] }, '')
    mountOverlays()
    expect(overlays.at(-1)).toEqual([{ kind: 'search' }, { kind: 'node', id: 9 }])
  })
})
