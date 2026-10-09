import { describe, expect, it } from 'vitest'
import {
  CAPSULE_MIN_WIDTH,
  INSET,
  PLAYER_MIN_WIDTH,
  RIGHT_PANEL_WIDTH,
  capsuleContentWidth,
  capsuleParts,
  computeShellLayout,
  idleContentWidth,
  idleParts,
  playerContentWidth,
  playerParts,
  type ShellLayout,
} from './layout'

describe('computeShellLayout', () => {
  it('centres on the window when only the rail is showing', () => {
    const layout = computeShellLayout(1440, 1024, { leftOpen: false, rightOpen: false })
    expect(layout.leftOccupancy).toBe(68)
    expect(layout.rightOccupancy).toBe(0)
    expect(layout.free).toBe(1372)
    expect(layout.cx).toBe(754)
    expect(layout.capsuleWidth).toBe(520)
    expect(layout.playerWidth).toBe(720)
    expect(layout.playerCx).toBe(754)
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
    // Both hold at their narrowest instead: the player at the transport's
    // width (#293), the capsule at its icons (#308).
    expect(layout.capsuleWidth).toBe(CAPSULE_MIN_WIDTH)
    expect(layout.playerWidth).toBe(PLAYER_MIN_WIDTH)
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
    expect(panelLeft - (layout.playerCx + layout.playerWidth / 2)).toBe(32)
  })

  it('never puts the player under the right panel while the transport fits beside it', () => {
    for (const leftOpen of [false, true]) {
      const narrowest = computeShellLayout(0, 0, { leftOpen, rightOpen: true })
      // From the narrowest window whose free space holds the transport and its margins, up to a wide monitor.
      const first = narrowest.leftOccupancy + narrowest.rightOccupancy + 48 + PLAYER_MIN_WIDTH
      for (let width = first; width <= 3840; width += 2) {
        const layout = computeShellLayout(width, 900, { leftOpen, rightOpen: true })
        const playerRight = layout.playerCx + layout.playerWidth / 2
        const panelLeft = width - INSET - RIGHT_PANEL_WIDTH
        expect(playerRight, `width ${width}, left ${leftOpen ? 'open' : 'closed'}`).toBeLessThanOrEqual(panelLeft - 32)
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
    for (let width = PLAYER_MIN_WIDTH; width <= 720; width++) {
      expect(playerContentWidth(playerParts(width)), `bar ${width}`).toBeLessThanOrEqual(width)
    }
  })

  it('stops narrowing at the transport, in the window, however narrow the window', () => {
    // Previous 30, play 34 and next 30, 6px apart, inside the bar's padding and border.
    expect(PLAYER_MIN_WIDTH).toBe(1 + 12 + 30 + 6 + 34 + 6 + 30 + 14 + 1)
    for (const leftOpen of [false, true]) {
      for (const rightOpen of [false, true]) {
        // From a small phone up to a wide monitor.
        for (let width = 320; width <= 3840; width += 2) {
          const layout = computeShellLayout(width, 900, { leftOpen, rightOpen })
          const label = `width ${width}, left ${leftOpen}, right ${rightOpen}`
          expect(layout.playerWidth, label).toBeGreaterThanOrEqual(PLAYER_MIN_WIDTH)
          expect(layout.playerCx - layout.playerWidth / 2, label).toBeGreaterThanOrEqual(INSET)
          expect(layout.playerCx + layout.playerWidth / 2, label).toBeLessThanOrEqual(width - INSET)
        }
      }
    }
  })

  it("holds at the transport's width in the issue's 900px browser window", () => {
    // Both panels open left 76px of bar before #293, and the transport was cut off.
    const layout = computeShellLayout(900, 700, { leftOpen: true, rightOpen: true })
    expect(layout.playerWidth).toBe(PLAYER_MIN_WIDTH)
    expect(layout.playerParts).toEqual(transportOnly)
  })
})

const PANELS = [
  { leftOpen: false, rightOpen: false },
  { leftOpen: true, rightOpen: false },
  { leftOpen: false, rightOpen: true },
  { leftOpen: true, rightOpen: true },
]

/* The glass either side of the free space: the rail or the left panel, and
 * the right panel or the window's inset edge. */
function panelEdges(layout: ShellLayout, rightOpen: boolean) {
  return { left: layout.leftOccupancy, right: layout.width - INSET - (rightOpen ? RIGHT_PANEL_WIDTH : 0) }
}

// #308: the capsule gives way the way the player does, down to the switch's
// icons and the magnifier.
describe('the capsule as it narrows', () => {
  const full = { switchLabels: true, searchLabel: 'full', searchShortcut: true }
  const short = { ...full, searchLabel: 'short' }
  const noShortcut = { ...short, searchShortcut: false }
  const magnifier = { ...noShortcut, searchLabel: null }
  const icons = { ...magnifier, switchLabels: false }

  // With both panels open the capsule is the window less 824px, up to 520.
  it.each([
    [1440, 520, full],
    [1335, 511, full],
    [1334, 510, short],
    [1188, 364, short],
    [1187, 363, noShortcut],
    [1127, 303, noShortcut],
    [1126, 302, magnifier],
    [1100, 276, magnifier],
    [1071, 247, magnifier],
    [1070, 246, icons],
    [959, 135, icons],
    [900, 135, icons],
  ])('a %ipx window with both panels open has a %ipx capsule', (windowWidth, capsule, parts) => {
    const layout = computeShellLayout(windowWidth, 900, { leftOpen: true, rightOpen: true })
    expect(layout.capsuleWidth).toBe(capsule)
    expect(layout.capsuleParts).toEqual(parts)
  })

  it('fits everything it shows at every capsule width', () => {
    for (let width = CAPSULE_MIN_WIDTH; width <= 520; width++) {
      expect(capsuleContentWidth(capsuleParts(width)), `capsule ${width}`).toBeLessThanOrEqual(width)
    }
  })

  it("adds the labelled switch up from Tabs' sizes, with room to spare for its text", () => {
    // Each segment is 14px either side of an 18px icon, 6px from its label ("map" 28, "library" 41), in the 2px well.
    const labelledSwitch = 2 + (14 + 18 + 6 + 28 + 14) + 2 + (14 + 18 + 6 + 41 + 14) + 2
    expect(capsuleContentWidth(magnifier)).toBe(1 + 6 + labelledSwitch + 10 + 1 + 10 + (18 + 10) + 8 + 1 + 3)
  })

  it('stops narrowing at its icons, in the window, however narrow the window', () => {
    // Two 32px segments in the switch's well, the divider, the magnifier, and the padding, gaps and border around them.
    // No text, so no slack for it.
    expect(CAPSULE_MIN_WIDTH).toBe(1 + 6 + (2 + 32 + 2 + 32 + 2) + 10 + 1 + 10 + (18 + 10) + 8 + 1)
    for (const panels of PANELS) {
      for (let width = 320; width <= 3840; width += 2) {
        const layout = computeShellLayout(width, 900, panels)
        const label = `width ${width}, ${JSON.stringify(panels)}`
        expect(layout.capsuleWidth, label).toBeGreaterThanOrEqual(CAPSULE_MIN_WIDTH)
        expect(layout.capsuleCx - layout.capsuleWidth / 2, label).toBeGreaterThanOrEqual(INSET)
        expect(layout.capsuleCx + layout.capsuleWidth / 2, label).toBeLessThanOrEqual(width - INSET)
      }
    }
  })

  it('never covers a panel at the desktop minimum or wider', () => {
    for (const panels of PANELS) {
      for (let width = 1100; width <= 3840; width += 2) {
        const layout = computeShellLayout(width, 900, panels)
        const edges = panelEdges(layout, panels.rightOpen)
        const label = `width ${width}, ${JSON.stringify(panels)}`
        expect(layout.capsuleCx - layout.capsuleWidth / 2, label).toBeGreaterThanOrEqual(edges.left)
        expect(layout.capsuleCx + layout.capsuleWidth / 2, label).toBeLessThanOrEqual(edges.right)
      }
    }
  })
})

// #308: with nothing loaded, the idle pill takes the bar's width as its
// limit and the bar's centre as its own, so it gives way where the bar does.
describe('the idle player as the bar narrows', () => {
  const full = { sentence: true, buttonLabel: true, shortcut: true }
  const noShortcut = { ...full, shortcut: false }
  const buttonAlone = { ...noShortcut, sentence: false }
  const iconAlone = { ...buttonAlone, buttonLabel: false }

  it.each([
    [1440, 616, full],
    [1152, 328, full],
    [1151, 327, noShortcut],
    [1100, 276, noShortcut],
    [1096, 272, noShortcut],
    [1095, 271, buttonAlone],
    [980, 156, buttonAlone],
    [979, 155, iconAlone],
    [900, 134, iconAlone],
  ])('a %ipx window with both panels open gives it a %ipx bar', (windowWidth, bar, parts) => {
    const layout = computeShellLayout(windowWidth, 900, { leftOpen: true, rightOpen: true })
    expect(layout.playerWidth).toBe(bar)
    expect(layout.idleParts).toEqual(parts)
  })

  it('fits everything it shows at every bar width', () => {
    for (let width = PLAYER_MIN_WIDTH; width <= 720; width++) {
      expect(idleContentWidth(idleParts(width)), `bar ${width}`).toBeLessThanOrEqual(width)
    }
  })

  it("adds the button up from Button's sizes, with room to spare for its text", () => {
    // 10px, the 16px icon, 6px, "Shuffle library" (89) and 14px, inside the pill's 8px padding and border.
    expect(idleContentWidth(buttonAlone)).toBe(1 + 8 + (10 + 16 + 6 + 89 + 14) + 8 + 1 + 3)
    // The space keycap: Kbd's border and 5px either side of "space" (32).
    expect(idleContentWidth(full) - idleContentWidth(noShortcut)).toBe(12 + (1 + 5 + 32 + 5 + 1))
  })

  it("stays inside the bar's box, so in the window, however narrow the window", () => {
    // The button's icon in a circle as wide as the pill is tall.
    expect(idleContentWidth(iconAlone)).toBe(52)
    for (const panels of PANELS) {
      for (let width = 320; width <= 3840; width += 2) {
        const layout = computeShellLayout(width, 900, panels)
        const half = idleContentWidth(layout.idleParts) / 2
        const label = `width ${width}, ${JSON.stringify(panels)}`
        expect(layout.playerCx - half, label).toBeGreaterThanOrEqual(layout.playerCx - layout.playerWidth / 2)
        expect(layout.playerCx + half, label).toBeLessThanOrEqual(layout.playerCx + layout.playerWidth / 2)
        expect(layout.playerCx - half, label).toBeGreaterThanOrEqual(INSET)
        expect(layout.playerCx + half, label).toBeLessThanOrEqual(width - INSET)
      }
    }
  })

  it('never overlaps a panel at the desktop minimum or wider', () => {
    // Before #308 it was a fixed 324px on cx, and at 1100 with both panels open it touched the left panel.
    for (const panels of PANELS) {
      for (let width = 1100; width <= 3840; width += 2) {
        const layout = computeShellLayout(width, 900, panels)
        const edges = panelEdges(layout, panels.rightOpen)
        const half = idleContentWidth(layout.idleParts) / 2
        const label = `width ${width}, ${JSON.stringify(panels)}`
        expect(layout.playerCx - half, label).toBeGreaterThanOrEqual(edges.left)
        expect(layout.playerCx + half, label).toBeLessThanOrEqual(edges.right)
      }
    }
  })
})

// #308: the capsule's centre can leave cx to keep it in the window, and the
// palette opens over the capsule, wherever that puts it.
describe('the search palette', () => {
  it('opens over the capsule, inside the window, in every panel state', () => {
    for (const panels of PANELS) {
      for (let width = 320; width <= 3840; width += 2) {
        const layout = computeShellLayout(width, 900, panels)
        const label = `width ${width}, ${JSON.stringify(panels)}`
        const half = layout.paletteWidth / 2
        expect(layout.paletteCx - half, label).toBeGreaterThanOrEqual(INSET)
        expect(layout.paletteCx + half, label).toBeLessThanOrEqual(width - INSET)
        // It covers the capsule, and centres on it whenever the window has the room.
        expect(layout.paletteCx - half, label).toBeLessThanOrEqual(layout.capsuleCx - layout.capsuleWidth / 2)
        expect(layout.paletteCx + half, label).toBeGreaterThanOrEqual(layout.capsuleCx + layout.capsuleWidth / 2)
        if (layout.capsuleCx - half >= INSET && layout.capsuleCx + half <= width - INSET) {
          expect(layout.paletteCx, label).toBe(layout.capsuleCx)
        }
      }
    }
  })

  it("follows the capsule where the capsule leaves the free space's centre", () => {
    // Only the left panel open: under 555px the capsule's floor would leave the window on cx.
    const layout = computeShellLayout(500, 900, { leftOpen: true, rightOpen: false })
    expect(layout.capsuleCx).toBeLessThan(layout.cx)
    expect(layout.paletteWidth).toBe(500 - 2 * INSET)
    expect(layout.paletteCx).toBe(250)
  })
})
