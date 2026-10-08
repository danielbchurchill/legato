import { createContext, useContext, useEffect, useState } from 'react'

/* The shell's geometry, as arithmetic rather than CSS, because three things
 * outside CSS need the same answers: the map's camera (which has to keep
 * nodes out from under the glass), the map's card (clamped to the free
 * space), and the search palette (centred on it).
 *
 * Everything floats 12px (INSET) in from the window. The rail is always
 * there; the left and right panels come and go, and each one that's open
 * takes its width out of the free space. The capsule, player and palette
 * centre on the middle of what's left, not the middle of the window, so
 * opening a panel slides them rather than covering them.
 *
 * Both panels run the full height. The player is never wider than the free
 * space less 48px, so it can't reach under the right panel, and whether one
 * is showing changes no geometry here: the right panel used to stop above
 * the player, which bought no room and made it jump 84px whenever playback
 * started or stopped (#288). */

export const INSET = 12
export const RAIL_WIDTH = 56
export const LEFT_PANEL_WIDTH = 320
export const RIGHT_PANEL_WIDTH = 360
export const PLAYER_HEIGHT = 72
export const CAPSULE_HEIGHT = 48
/* The gap between the rail and the left panel. */
const PANEL_GAP = 8

/* Left occupancy: inset + rail, plus the gap and panel when it's open. */
const LEFT_OCCUPANCY_CLOSED = INSET + RAIL_WIDTH // 68
const LEFT_OCCUPANCY_OPEN = LEFT_OCCUPANCY_CLOSED + PANEL_GAP + LEFT_PANEL_WIDTH // 396
/* Right occupancy: the panel and its inset plus a gap, or nothing. */
const RIGHT_OCCUPANCY_OPEN = RIGHT_PANEL_WIDTH + INSET + PANEL_GAP // 380

/* Under this, the player drops its title column to 112px and its waveform to
 * 24 bars, so the transport keeps its room. */
export const COMPACT_PLAYER_WIDTH = 600

export type ShellLayout = {
  width: number
  height: number
  leftOccupancy: number
  rightOccupancy: number
  /** Width between the two occupancies. */
  free: number
  /** Horizontal centre of the free space. */
  cx: number
  capsuleWidth: number
  playerWidth: number
  compactPlayer: boolean
  /** Where the map's toolbar and legend sit: above the player's row. */
  floatingBottom: number
}

export function computeShellLayout(
  width: number,
  height: number,
  { leftOpen, rightOpen }: { leftOpen: boolean; rightOpen: boolean },
): ShellLayout {
  const leftOccupancy = leftOpen ? LEFT_OCCUPANCY_OPEN : LEFT_OCCUPANCY_CLOSED
  const rightOccupancy = rightOpen ? RIGHT_OCCUPANCY_OPEN : 0
  const free = Math.max(0, width - leftOccupancy - rightOccupancy)
  const playerWidth = Math.max(0, Math.min(720, free - 48))
  return {
    width,
    height,
    leftOccupancy,
    rightOccupancy,
    free,
    cx: (leftOccupancy + (width - rightOccupancy)) / 2,
    capsuleWidth: Math.max(0, Math.min(520, free - 48)),
    playerWidth,
    compactPlayer: playerWidth < COMPACT_PLAYER_WIDTH,
    floatingBottom: INSET + PLAYER_HEIGHT + INSET,
  }
}

const FALLBACK = computeShellLayout(1440, 1024, { leftOpen: false, rightOpen: false })

export const ShellLayoutContext = createContext<ShellLayout>(FALLBACK)

export function useShellLayout(): ShellLayout {
  return useContext(ShellLayoutContext)
}

export function useWindowSize(): { width: number; height: number } {
  const [size, setSize] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }))
  useEffect(() => {
    const onResize = () => setSize({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return size
}
