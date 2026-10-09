import { createContext, useContext, useEffect, useState } from 'react'
import {
  CAPSULE_BORDER,
  CAPSULE_DIVIDER_WIDTH,
  CAPSULE_GAP,
  CAPSULE_LIBRARY_LABEL_WIDTH,
  CAPSULE_MAP_LABEL_WIDTH,
  CAPSULE_PADDING_LEFT,
  CAPSULE_PADDING_RIGHT,
  CAPSULE_PLACEHOLDER_WIDTH,
  CAPSULE_SEARCH_GAP,
  CAPSULE_SEARCH_ICON_SIZE,
  CAPSULE_SEARCH_PADDING_RIGHT,
  CAPSULE_SEARCH_WORD_WIDTH,
  CAPSULE_SHORTCUT_TEXT_WIDTH,
} from './capsuleGeometry'
import {
  BUTTON_ICON_GAP,
  BUTTON_ICON_SIZE,
  BUTTON_MD_HEIGHT,
  BUTTON_PADDING_LEFT,
  BUTTON_PADDING_RIGHT,
  KBD_BORDER,
  KBD_PADDING,
  TABS_ICON_GAP,
  TABS_LG_ICON_SIZE,
  TABS_LG_PADDING,
  TABS_LG_SQUARE,
  TABS_SEGMENT_GAP,
  TABS_WELL_PADDING,
} from './controlGeometry'
import {
  IDLE_BUTTON_LABEL_WIDTH,
  IDLE_GAP,
  IDLE_HEIGHT,
  IDLE_PADDING,
  IDLE_PADDING_TEXT,
  IDLE_SENTENCE_WIDTH,
  IDLE_SHORTCUT_TEXT_WIDTH,
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
 * controls' icons, and the idle pill fits inside the player's width at the
 * player's centre, so neither covers a panel the player wouldn't (#308). */

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

/* The capsule's and the idle pill's text widths are Chromium's
 * (capsuleGeometry.ts, playerGeometry.ts). Another engine, or a fallback
 * font before Rubik loads, can draw a label a few px wider, so a set of
 * parts that shows any text keeps this much to spare. Both pills also clip
 * to their own width, so text wider still is cut off at the edge rather than
 * spilling out (#308). */
const TEXT_SLACK = 3

/* A row of parts with a gap between each. A width of 0 is a part that isn't
 * shown, so it takes no gap either. */
function sumWithGaps(widths: number[], gap: number): number {
  const shown = widths.filter((w) => w > 0)
  return shown.reduce((sum, w) => sum + w, 0) + gap * Math.max(0, shown.length - 1)
}

/* Each set of parts a piece of the shell can show, beside the width it
 * needs. The sizes never change, so these are worked out once, when the
 * module loads, rather than on every resize. */
type Stage<Parts> = { parts: Parts; width: number }

function stagesOf<Parts>(sets: Parts[], contentWidth: (parts: Parts) => number): Stage<Parts>[] {
  return sets.map((parts) => ({ parts, width: contentWidth(parts) }))
}

/* The widest set that fits, or else the last, the narrowest the piece gets. */
function pickStage<Parts>(stages: Stage<Parts>[], width: number): Parts {
  return (stages.find((stage) => stage.width <= width) ?? stages[stages.length - 1]).parts
}

/* cx, unless a box that wide centred there would cross the window's inset. */
function clampCentre(cx: number, boxWidth: number, width: number): number {
  return Math.min(Math.max(cx, INSET + boxWidth / 2), width - INSET - boxWidth / 2)
}

/* A keycap: Kbd's border and padding either side of the key's name. */
function keycapWidth(textWidth: number): number {
  return KBD_BORDER + KBD_PADDING + textWidth + KBD_PADDING + KBD_BORDER
}

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
const PLAYER_STAGES = stagesOf<PlayerParts>(
  [
    { cover: true, titleWidth: 180, shuffleAndRepeat: true, waveformBars: 56, queueAndVolume: true },
    { cover: true, titleWidth: 112, shuffleAndRepeat: true, waveformBars: 24, queueAndVolume: true },
    { cover: true, titleWidth: 0, shuffleAndRepeat: true, waveformBars: 24, queueAndVolume: true },
    { cover: true, titleWidth: 0, shuffleAndRepeat: true, waveformBars: 24, queueAndVolume: false },
    { cover: false, titleWidth: 0, shuffleAndRepeat: true, waveformBars: 24, queueAndVolume: false },
    { cover: false, titleWidth: 0, shuffleAndRepeat: false, waveformBars: 0, queueAndVolume: false },
  ],
  playerContentWidth,
)

/* The width a set of parts needs, from the sizes Player.tsx draws them at
 * (playerGeometry.ts). The transport sits over the scrubber, so the middle
 * column is the wider of the two. */
export function playerContentWidth(parts: PlayerParts): number {
  const shuffle = parts.shuffleAndRepeat ? PLAYER_SHUFFLE_SIZE : 0
  const repeat = parts.shuffleAndRepeat ? PLAYER_REPEAT_SIZE : 0
  const transport = sumWithGaps([shuffle, PLAYER_SKIP_SIZE, PLAYER_PLAY_SIZE, PLAYER_SKIP_SIZE, repeat], PLAYER_TRANSPORT_GAP)
  const bars = parts.waveformBars
  const waveform = bars * PLAYER_BAR_MIN_WIDTH + (bars - 1) * PLAYER_BAR_GAP
  const scrubber = bars > 0 ? sumWithGaps([PLAYER_TIME_WIDTH, waveform, PLAYER_TIME_WIDTH], PLAYER_SCRUBBER_GAP) : 0
  const queueAndVolume = parts.queueAndVolume ? sumWithGaps([PLAYER_QUEUE_SIZE, PLAYER_VOLUME_SIZE], PLAYER_QUEUE_VOLUME_GAP) : 0
  const content = sumWithGaps(
    [parts.cover ? PLAYER_COVER_SIZE : 0, parts.titleWidth, Math.max(transport, scrubber), queueAndVolume],
    PLAYER_COLUMN_GAP,
  )
  return PLAYER_BORDER + PLAYER_PADDING_LEFT + content + PLAYER_PADDING_RIGHT + PLAYER_BORDER
}

export function playerParts(playerWidth: number): PlayerParts {
  return pickStage(PLAYER_STAGES, playerWidth)
}

/* The transport alone: the narrowest the player gets. */
export const PLAYER_MIN_WIDTH = PLAYER_STAGES[PLAYER_STAGES.length - 1].width

/* What the idle pill shows, with nothing loaded. The button is always
 * there; without its label it's named for screen readers and in a tooltip. */
export type IdleParts = {
  /** "Nothing playing". */
  sentence: boolean
  /** "Shuffle library" beside the button's icon. */
  buttonLabel: boolean
  /** The space keycap. */
  shortcut: boolean
}

/* The idle pill takes the bar's width as its limit and gives way in its own
 * order (DESIGN.md, Shell). The narrowest bar each set fits:
 *
 *   328  everything
 *   272  no space keycap: it says what the button does
 *   156  no "Nothing playing": the button alone says it
 *    52  the button's icon alone, in a round pill
 *
 * The last is under the bar's 134px floor, so the pill always fits. */
const IDLE_STAGES = stagesOf<IdleParts>(
  [
    { sentence: true, buttonLabel: true, shortcut: true },
    { sentence: true, buttonLabel: true, shortcut: false },
    { sentence: false, buttonLabel: true, shortcut: false },
    { sentence: false, buttonLabel: false, shortcut: false },
  ],
  idleContentWidth,
)

/* The width a set of idle parts needs: the most the pill draws, since it
 * hugs its content and the text widths are rounded up, plus the slack for
 * text. Alone, the button's icon sits in a circle as wide as the pill is
 * tall. */
export function idleContentWidth(parts: IdleParts): number {
  const button = parts.buttonLabel
    ? BUTTON_PADDING_LEFT + sumWithGaps([BUTTON_ICON_SIZE, IDLE_BUTTON_LABEL_WIDTH], BUTTON_ICON_GAP) + BUTTON_PADDING_RIGHT
    : BUTTON_MD_HEIGHT
  const content = sumWithGaps(
    [parts.sentence ? IDLE_SENTENCE_WIDTH : 0, button, parts.shortcut ? keycapWidth(IDLE_SHORTCUT_TEXT_WIDTH) : 0],
    IDLE_GAP,
  )
  const paddingLeft = parts.sentence ? IDLE_PADDING_TEXT : IDLE_PADDING
  const slack = parts.sentence || parts.buttonLabel || parts.shortcut ? TEXT_SLACK : 0
  return Math.max(IDLE_HEIGHT, PLAYER_BORDER + paddingLeft + content + IDLE_PADDING + PLAYER_BORDER + slack)
}

export function idleParts(playerWidth: number): IdleParts {
  return pickStage(IDLE_STAGES, playerWidth)
}

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
 *   511  everything
 *   364  the placeholder shortens to "Search"
 *   303  no keycap; ⌘K and / still open search
 *   247  no "Search": the magnifier alone
 *   135  the switch's icons alone, its labels in tooltips and for screen readers
 *
 * It doesn't get narrower than the last. The words go before the switch's
 * labels because a magnifier needs no caption and the map and library icons
 * are Legato's own. */
const CAPSULE_STAGES = stagesOf<CapsuleParts>(
  [
    { switchLabels: true, searchLabel: 'full', searchShortcut: true },
    { switchLabels: true, searchLabel: 'short', searchShortcut: true },
    { switchLabels: true, searchLabel: 'short', searchShortcut: false },
    { switchLabels: true, searchLabel: null, searchShortcut: false },
    { switchLabels: false, searchLabel: null, searchShortcut: false },
  ],
  capsuleContentWidth,
)

/* The width a set of capsule parts needs, from capsuleGeometry.ts and the
 * switch's and keycap's sizes in controlGeometry.ts, plus the slack for
 * text. */
export function capsuleContentWidth(parts: CapsuleParts): number {
  const segment = (labelWidth: number) => TABS_LG_PADDING + sumWithGaps([TABS_LG_ICON_SIZE, labelWidth], TABS_ICON_GAP) + TABS_LG_PADDING
  const segments = parts.switchLabels
    ? [segment(CAPSULE_MAP_LABEL_WIDTH), segment(CAPSULE_LIBRARY_LABEL_WIDTH)]
    : [TABS_LG_SQUARE, TABS_LG_SQUARE]
  const switchWidth = TABS_WELL_PADDING + sumWithGaps(segments, TABS_SEGMENT_GAP) + TABS_WELL_PADDING
  const label = parts.searchLabel === 'full' ? CAPSULE_PLACEHOLDER_WIDTH : parts.searchLabel === 'short' ? CAPSULE_SEARCH_WORD_WIDTH : 0
  const shortcut = parts.searchShortcut ? keycapWidth(CAPSULE_SHORTCUT_TEXT_WIDTH) : 0
  const search = sumWithGaps([CAPSULE_SEARCH_ICON_SIZE, label, shortcut], CAPSULE_SEARCH_GAP) + CAPSULE_SEARCH_PADDING_RIGHT
  const content = sumWithGaps([switchWidth, CAPSULE_DIVIDER_WIDTH, search], CAPSULE_GAP)
  const slack = parts.switchLabels || parts.searchLabel != null || parts.searchShortcut ? TEXT_SLACK : 0
  return CAPSULE_BORDER + CAPSULE_PADDING_LEFT + content + CAPSULE_PADDING_RIGHT + CAPSULE_BORDER + slack
}

export function capsuleParts(capsuleWidth: number): CapsuleParts {
  return pickStage(CAPSULE_STAGES, capsuleWidth)
}

/* The switch's icons and the magnifier: the narrowest the capsule gets. */
export const CAPSULE_MIN_WIDTH = CAPSULE_STAGES[CAPSULE_STAGES.length - 1].width

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
  /** What the idle pill shows. It centres on playerCx. */
  idleParts: IdleParts
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
    capsuleCx: clampCentre(cx, capsuleWidth, width),
    capsuleParts: capsuleParts(capsuleWidth),
    playerWidth,
    playerCx: clampCentre(cx, playerWidth, width),
    playerParts: playerParts(playerWidth),
    idleParts: idleParts(playerWidth),
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
