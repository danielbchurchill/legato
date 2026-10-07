import { describe, expect, it } from 'vitest'
import { computeShellLayout } from './layout'

describe('computeShellLayout', () => {
  it('centres on the window when only the rail is showing', () => {
    const layout = computeShellLayout(1440, 1024, { leftOpen: false, rightOpen: false, playerVisible: false })
    expect(layout.leftOccupancy).toBe(68)
    expect(layout.rightOccupancy).toBe(0)
    expect(layout.free).toBe(1372)
    expect(layout.cx).toBe(754)
    expect(layout.capsuleWidth).toBe(520)
    expect(layout.playerWidth).toBe(720)
    expect(layout.rightPanelBottom).toBe(12)
  })

  it('takes both panels out of the free space and centres between them', () => {
    const layout = computeShellLayout(1440, 1024, { leftOpen: true, rightOpen: true, playerVisible: true })
    expect(layout.leftOccupancy).toBe(396)
    expect(layout.rightOccupancy).toBe(380)
    expect(layout.free).toBe(664)
    expect(layout.cx).toBe((396 + 1060) / 2)
    // min(720, 664 - 48)
    expect(layout.playerWidth).toBe(616)
    expect(layout.compactPlayer).toBe(false)
    expect(layout.rightPanelBottom).toBe(96)
  })

  it('switches the player to its compact layout under 600px', () => {
    const layout = computeShellLayout(1280, 800, { leftOpen: true, rightOpen: true, playerVisible: true })
    expect(layout.playerWidth).toBe(1280 - 396 - 380 - 48)
    expect(layout.compactPlayer).toBe(true)
  })

  it('never reports a negative width for a window narrower than its panels', () => {
    const layout = computeShellLayout(600, 600, { leftOpen: true, rightOpen: true, playerVisible: true })
    expect(layout.free).toBe(0)
    expect(layout.playerWidth).toBe(0)
    expect(layout.capsuleWidth).toBe(0)
  })
})
