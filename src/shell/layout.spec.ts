import { describe, expect, it } from 'vitest'
import { INSET, RIGHT_PANEL_WIDTH, computeShellLayout, playerContentWidth, playerParts } from './layout'

describe('computeShellLayout', () => {
  it('centres on the window when only the rail is showing', () => {
    const layout = computeShellLayout(1440, 1024, { leftOpen: false, rightOpen: false })
    expect(layout.leftOccupancy).toBe(68)
    expect(layout.rightOccupancy).toBe(0)
    expect(layout.free).toBe(1372)
    expect(layout.cx).toBe(754)
    expect(layout.capsuleWidth).toBe(520)
    expect(layout.playerWidth).toBe(720)
  })

  it('takes both panels out of the free space and centres between them', () => {
    const layout = computeShellLayout(1440, 1024, { leftOpen: true, rightOpen: true })
    expect(layout.leftOccupancy).toBe(396)
    expect(layout.rightOccupancy).toBe(380)
    expect(layout.free).toBe(664)
    expect(layout.cx).toBe((396 + 1060) / 2)
    // min(720, 664 - 48)
    expect(layout.playerWidth).toBe(616)
    expect(layout.playerParts.titleWidth).toBe(180)
  })

  it('never reports a negative width for a window narrower than its panels', () => {
    const layout = computeShellLayout(600, 600, { leftOpen: true, rightOpen: true })
    expect(layout.free).toBe(0)
    expect(layout.playerWidth).toBe(0)
    expect(layout.capsuleWidth).toBe(0)
  })

  // #288: the right panel runs to the bottom inset like the left one, so
  // what keeps it clear of the player is the player staying out of its
  // column, not the panel stopping short above it.
  it('lays the shell out the same whether or not a track is playing', () => {
    const idle = computeShellLayout(1440, 1024, { leftOpen: true, rightOpen: true })
    // @ts-expect-error playback isn't a layout input, so nothing can move when it starts or stops
    const playing = computeShellLayout(1440, 1024, { leftOpen: true, rightOpen: true, playerVisible: true })
    expect(playing).toEqual(idle)
    expect(idle).not.toHaveProperty('rightPanelBottom')
  })

  it('keeps the player 32px clear of the right panel at the narrowest desktop window', () => {
    // tauri.conf.json's minWidth, with both panels open: the tightest the app gets.
    const layout = computeShellLayout(1100, 700, { leftOpen: true, rightOpen: true })
    const panelLeft = 1100 - INSET - RIGHT_PANEL_WIDTH
    expect(layout.playerWidth).toBe(276)
    expect(panelLeft - (layout.cx + layout.playerWidth / 2)).toBe(32)
  })

  it('never puts the player under the right panel, in a narrow window or a wide one', () => {
    for (const leftOpen of [false, true]) {
      const narrowest = computeShellLayout(0, 0, { leftOpen, rightOpen: true })
      // From the narrowest window that fits both panels side by side up to a wide monitor.
      for (let width = narrowest.leftOccupancy + narrowest.rightOccupancy; width <= 3840; width += 2) {
        const layout = computeShellLayout(width, 900, { leftOpen, rightOpen: true })
        const playerRight = layout.cx + layout.playerWidth / 2
        const panelLeft = width - INSET - RIGHT_PANEL_WIDTH
        expect(playerRight, `width ${width}, left ${leftOpen ? 'open' : 'closed'}`).toBeLessThanOrEqual(
          panelLeft - (layout.playerWidth > 0 ? 32 : 8),
        )
      }
    }
  })
})

// #293: the bar narrows with the free space, and what it holds gives way in
// a fixed order, down to previous, play/pause and next.
describe('the player as its bar narrows', () => {
  const full = { cover: true, titleWidth: 180, shuffleAndRepeat: true, waveformBars: 56, queueAndVolume: true }
  const compact = { ...full, titleWidth: 112, waveformBars: 24 }
  const noTitle = { ...compact, titleWidth: 0 }
  const noQueueOrVolume = { ...noTitle, queueAndVolume: false }
  const noCover = { ...noQueueOrVolume, cover: false }
  const transportOnly = { ...noCover, shuffleAndRepeat: false, waveformBars: 0 }

  // With both panels open, the bar is the window less 824px, so each part
  // drops out at a window width as well as a bar width.
  it.each([
    [1544, 720, full],
    [1438, 614, full],
    [1437, 613, compact],
    [1294, 470, compact],
    [1293, 469, noTitle],
    [1168, 344, noTitle],
    [1167, 343, noQueueOrVolume],
    [1100, 276, noQueueOrVolume],
    [1088, 264, noQueueOrVolume],
    [1087, 263, noCover],
    [1026, 202, noCover],
    [1025, 201, transportOnly],
    [958, 134, transportOnly],
  ])('a %ipx window with both panels open has a %ipx bar', (windowWidth, bar, parts) => {
    const layout = computeShellLayout(windowWidth, 900, { leftOpen: true, rightOpen: true })
    expect(layout.playerWidth).toBe(bar)
    expect(layout.playerParts).toEqual(parts)
  })

  it('fits everything it shows at every bar width', () => {
    for (let width = playerContentWidth(transportOnly); width <= 720; width++) {
      expect(playerContentWidth(playerParts(width)), `bar ${width}`).toBeLessThanOrEqual(width)
    }
  })
})
