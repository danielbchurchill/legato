import { describe, expect, it } from 'vitest'
import type { SheetOverlay } from './navigation'
import { overlayTransition, type Depth } from './sheetOverlays'
import type { Detent } from './sheetGeometry'

const search: SheetOverlay = { kind: 'search' }
const node = (id: number): SheetOverlay => ({ kind: 'node', id })
const none = new Map<Depth, Detent>()

describe("the sheet's detent as its overlays change", () => {
  it('does nothing when nothing changed', () => {
    expect(overlayTransition([node(1)], [node(1)], 'medium', none)).toBeNull()
    expect(overlayTransition([], [], 'peek', none)).toBeNull()
  })

  it('opens search at large and a node at medium, remembering the tabs under them', () => {
    expect(overlayTransition([], [search], 'peek', none)).toEqual({ detent: 'large', saved: new Map([[-1, 'peek']]) })
    expect(overlayTransition([], [node(1)], 'large', none)).toEqual({ detent: 'medium', saved: new Map([[-1, 'large']]) })
  })

  it('goes back to the library as tall as it was', () => {
    const opened = overlayTransition([], [node(1)], 'large', none)!
    expect(overlayTransition([node(1)], [], opened.detent, opened.saved)).toEqual({ detent: 'large', saved: new Map() })
  })

  it('goes back from a node opened from search to search where it was left', () => {
    const searched = overlayTransition([], [search], 'peek', none)!
    // The results dragged down to medium before a result was opened.
    const opened = overlayTransition([search], [search, node(4)], 'medium', searched.saved)!
    expect(opened.detent).toBe('medium')
    const back = overlayTransition([search, node(4)], [search], 'large', opened.saved)!
    expect(back).toEqual({ detent: 'medium', saved: new Map([[-1, 'peek']]) })
    expect(overlayTransition([search], [], back.detent, back.saved)).toEqual({ detent: 'peek', saved: new Map() })
  })

  it('replaces a node in place, keeping what the one under it remembered', () => {
    const opened = overlayTransition([], [node(1)], 'peek', none)!
    // A tap on another node on the map, with this one dragged up to large.
    const replaced = overlayTransition([node(1)], [node(2)], 'large', opened.saved)!
    expect(replaced).toEqual({ detent: 'medium', saved: new Map([[-1, 'peek']]) })
    expect(overlayTransition([node(2)], [], 'medium', replaced.saved)!.detent).toBe('peek')
  })

  it('walks back through nodes opened from inside one another', () => {
    let state = overlayTransition([], [node(1)], 'peek', none)!
    state = overlayTransition([node(1)], [node(1), node(2)], 'large', state.saved)!
    state = overlayTransition([node(1), node(2)], [node(1), node(2), node(3)], 'medium', state.saved)!
    expect(state.detent).toBe('medium')
    state = overlayTransition([node(1), node(2), node(3)], [node(1), node(2)], 'medium', state.saved)!
    expect(state.detent).toBe('medium')
    state = overlayTransition([node(1), node(2)], [node(1)], 'medium', state.saved)!
    expect(state.detent).toBe('large')
    expect(overlayTransition([node(1)], [], 'large', state.saved)!.detent).toBe('peek')
  })

  it('goes back several overlays at once, as history.go does, to the deepest one left', () => {
    let state = overlayTransition([], [search], 'medium', none)!
    state = overlayTransition([search], [search, node(1)], 'large', state.saved)!
    state = overlayTransition([search, node(1)], [search, node(1), node(2)], 'peek', state.saved)!
    expect(overlayTransition([search, node(1), node(2)], [], 'medium', state.saved)).toEqual({ detent: 'medium', saved: new Map() })
  })

  it('opens an overlay at its own detent with nothing remembered, as after a reload', () => {
    // Back from a node to search, with nothing saved for search.
    expect(overlayTransition([search, node(1)], [search], 'medium', none)!.detent).toBe('large')
    expect(overlayTransition([node(1)], [], 'medium', none)!.detent).toBe('peek')
  })
})
