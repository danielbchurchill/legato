import { createContext, useContext, useEffect, useState } from 'react'
import {
  CAPSULE_BORDER,
  CAPSULE_DIVIDER_WIDTH,
  CAPSULE_GAP,
  CAPSULE_PADDING_LEFT,
  CAPSULE_PADDING_RIGHT,
  CAPSULE_PLACEHOLDER_WIDTH,
  CAPSULE_SEARCH_GAP,
  CAPSULE_SEARCH_ICON_SIZE,
  CAPSULE_SEARCH_PADDING_RIGHT,
  CAPSULE_SEARCH_WORD_WIDTH,
  CAPSULE_SHORTCUT_WIDTH,
  CAPSULE_SWITCH_ICONS_WIDTH,
  CAPSULE_SWITCH_WIDTH,
} from './capsuleGeometry'
import {
  PLAYER_BAR_GAP,
  PLAYER_BAR_MIN_WIDTH,
  PLAYER_BORDER,
  PLAYER_COLUMN_GAP,
  PLAYER_COVER_SIZE,
  PLAYER_PADDING_LEFT,
  PLAYER_PADDING_RIGHT,
  PLAYER_PLAY_SIZE,
  PLAYER_QUEUE_SIZE,
  PLAYER_QUEUE_VOLUME_GAP,
  PLAYER_REPEAT_SIZE,
  PLAYER_SCRUBBER_GAP,
  PLAYER_SHUFFLE_SIZE,
  PLAYER_SKIP_SIZE,
  PLAYER_TIME_WIDTH,
  PLAYER_TRANSPORT_GAP,
  PLAYER_VOLUME_SIZE,
} from './playerGeometry'

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
 * started or stopped (#288). The one exception is a window too narrow for
 * the transport between the panels, which only a browser reaches: there the
 * player holds at the transport's width and floats over the panels' inner
 * edges, still inside the window, because play/pause can't be the thing
 * that goes (#293). The capsule does the same at the top, holding at its two
 * controls' icons (#308). */

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

/* What the player shows. A dropped title stays for screen readers; the rest
 * isn't drawn at all. */
export type PlayerParts = {
  cover: boolean
  /** The title column's width, or 0 when it's dropped. */
  titleWidth: number
  shuffleAndRepeat: boolean
  /** Bars in the waveform, or 0 when the scrubber's dropped. */
  waveformBars: number
  queueAndVolume: boolean
}

/* As the bar narrows, the player's parts give way in a fixed order, each at
 * the width where it stops fitting (DESIGN.md, Shell). The narrowest bar
 * each set fits, widest first:
 *
 *   614  everything: a 180px title column and 56 waveform bars
 *   470  compact: a 112px title column and 24 bars
 *   344  no title column; the cover still says what's playing
 *   264  no queue or volume (the desktop minimum, 276, lands here)
 *   202  no cover
 *   134  previous, play/pause and next alone: no shuffle, repeat or scrubber
 *
 * Those three never go, and the bar doesn't get narrower than they are. The
 * handoff puts the compact switch at 600, but 56 bars at their 1px minimum
 * with 2px gaps only fit from 614; between the two, the waveform ran 6px
 * into the duration. */
const PLAYER_STAGES: PlayerParts[] = [
  { cover: true, titleWidth: 180, shuffleAndRepeat: true, waveformBars: 56, queueAndVolume: true },
  { cover: true, titleWidth: 112, shuffleAndRepeat: true, waveformBars: 24, queueAndVolume: true },
  { cover: true, titleWidth: 0, shuffleAndRepeat: true, waveformBars: 24, queueAndVolume: true },
  { cover: true, titleWidth: 0, shuffleAndRepeat: true, waveformBars: 24, queueAndVolume: false },
  { cover: false, titleWidth: 0, shuffleAndRepeat: true, waveformBars: 24, queueAndVolume: false },
  { cover: false, titleWidth: 0, shuffleAndRepeat: false, waveformBars: 0, queueAndVolume: false },
]

/* The width a set of parts needs, from the sizes Player.tsx draws them at
 * (playerGeometry.ts). The transport sits over the scrubber, so the middle
 * column is the wider of the two. */
export function playerContentWidth(parts: PlayerParts): number {
  const skipAndPlay = PLAYER_SKIP_SIZE + PLAYER_TRANSPORT_GAP + PLAYER_PLAY_SIZE + PLAYER_TRANSPORT_GAP + PLAYER_SKIP_SIZE
  const transport = parts.shuffleAndRepeat
    ? PLAYER_SHUFFLE_SIZE + PLAYER_TRANSPORT_GAP + skipAndPlay + PLAYER_TRANSPORT_GAP + PLAYER_REPEAT_SIZE
    : skipAndPlay
  const bars = parts.waveformBars
  const waveform = bars * PLAYER_BAR_MIN_WIDTH + (bars - 1) * PLAYER_BAR_GAP
  const scrubber = bars > 0 ? PLAYER_TIME_WIDTH + PLAYER_SCRUBBER_GAP + waveform + PLAYER_SCRUBBER_GAP + PLAYER_TIME_WIDTH : 0
  const queueAndVolume = PLAYER_QUEUE_SIZE + PLAYER_QUEUE_VOLUME_GAP + PLAYER_VOLUME_SIZE
  const columns = [
    parts.cover ? PLAYER_COVER_SIZE : 0,
    parts.titleWidth,
    Math.max(transport, scrubber),
    parts.queueAndVolume ? queueAndVolume : 0,
  ]
  const shown = columns.filter((w) => w > 0)
  const content = shown.reduce((sum, w) => sum + w, 0) + PLAYER_COLUMN_GAP * (shown.length - 1)
  return PLAYER_BORDER + PLAYER_PADDING_LEFT + content + PLAYER_PADDING_RIGHT + PLAYER_BORDER
}

export function playerParts(playerWidth: number): PlayerParts {
  return PLAYER_STAGES.find((parts) => playerContentWidth(parts) <= playerWidth) ?? PLAYER_STAGES[PLAYER_STAGES.length - 1]
}

/* The transport alone: the narrowest the player gets. */
export const PLAYER_MIN_WIDTH = playerContentWidth(PLAYER_STAGES[PLAYER_STAGES.length - 1])

/* What the capsule shows. A dropped label stays for screen readers, and
 * both controls, the map/library switch and the search field, stay. */
export type CapsuleParts = {
  /** "map" and "library" beside the switch's icons. */
  switchLabels: boolean
  /** The search field's placeholder: the sentence, "Search", or nothing
   * beside the magnifier. */
  searchLabel: 'full' | 'short' | null
  /** The ⌘K / Ctrl K keycap. */
  searchShortcut: boolean
}

/* The capsule gives way the same way (#308), at the capsule width where each
 * set stops fitting, widest first:
 *
 *   507  everything
 *   360  the placeholder shortens to "Search"
 *   299  no keycap; ⌘K and / still open search
 *   243  no "Search": the magnifier alone
 *   135  the switch's icons alone, its labels kept for screen readers
 *
 * It doesn't get narrower than the last. The words go before the switch's
 * labels because a magnifier needs no caption and the map and library icons
 * are Legato's own. */
const CAPSULE_STAGES: CapsuleParts[] = [
  { switchLabels: true, searchLabel: 'full', searchShortcut: true },
  { switchLabels: true, searchLabel: 'short', searchShortcut: true },
  { switchLabels: true, searchLabel: 'short', searchShortcut: false },
  { switchLabels: true, searchLabel: null, searchShortcut: false },
  { switchLabels: false, searchLabel: null, searchShortcut: false },
]

/* The width a set of capsule parts needs, from capsuleGeometry.ts. */
export function capsuleContentWidth(parts: CapsuleParts): number {
  const label = parts.searchLabel === 'full' ? CAPSULE_PLACEHOLDER_WIDTH : parts.searchLabel === 'short' ? CAPSULE_SEARCH_WORD_WIDTH : 0
  const searchItems = [CAPSULE_SEARCH_ICON_SIZE, label, parts.searchShortcut ? CAPSULE_SHORTCUT_WIDTH : 0].filter((w) => w > 0)
  const search = searchItems.reduce((sum, w) => sum + w, 0) + CAPSULE_SEARCH_GAP * (searchItems.length - 1) + CAPSULE_SEARCH_PADDING_RIGHT
  const switchWidth = parts.switchLabels ? CAPSULE_SWITCH_WIDTH : CAPSULE_SWITCH_ICONS_WIDTH
  const content = switchWidth + CAPSULE_GAP + CAPSULE_DIVIDER_WIDTH + CAPSULE_GAP + search
  return CAPSULE_BORDER + CAPSULE_PADDING_LEFT + content + CAPSULE_PADDING_RIGHT + CAPSULE_BORDER
}

export function capsuleParts(capsuleWidth: number): CapsuleParts {
  return CAPSULE_STAGES.find((parts) => capsuleContentWidth(parts) <= capsuleWidth) ?? CAPSULE_STAGES[CAPSULE_STAGES.length - 1]
}

/* The switch's icons and the magnifier: the narrowest the capsule gets. */
export const CAPSULE_MIN_WIDTH = capsuleContentWidth(CAPSULE_STAGES[CAPSULE_STAGES.length - 1])

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
  /** The capsule's centre: cx, unless that would push it off the window. */
  capsuleCx: number
  capsuleParts: CapsuleParts
  playerWidth: number
  /** The player's centre: cx, unless that would push the bar off the window. */
  playerCx: number
  playerParts: PlayerParts
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
  const cx = (leftOccupancy + (width - rightOccupancy)) / 2
  const capsuleWidth = Math.max(CAPSULE_MIN_WIDTH, Math.min(520, free - 48))
  const playerWidth = Math.max(PLAYER_MIN_WIDTH, Math.min(720, free - 48))
  return {
    width,
    height,
    leftOccupancy,
    rightOccupancy,
    free,
    cx,
    capsuleWidth,
    capsuleCx: Math.min(Math.max(cx, INSET + capsuleWidth / 2), width - INSET - capsuleWidth / 2),
    capsuleParts: capsuleParts(capsuleWidth),
    playerWidth,
    playerCx: Math.min(Math.max(cx, INSET + playerWidth / 2), width - INSET - playerWidth / 2),
    playerParts: playerParts(playerWidth),
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
