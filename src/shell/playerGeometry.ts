/* The player's horizontal sizes, in px: one copy, read by both sides.
 * Player.tsx draws with them, and layout.ts's playerContentWidth adds them
 * up to decide which parts fit the bar. A size written into Player.tsx
 * instead would move the drawing without moving the thresholds, and the
 * parts would clip again with nothing failing (#293). Player.spec.tsx checks
 * that what's drawn carries these sizes, and layout.spec.ts pins the
 * thresholds they add up to. */

/** The `glass` utility's border (index.css), on each side of the bar. The
 * one size here Player.tsx doesn't set: it comes with the material, and the
 * specs can't read it, since vitest loads CSS as empty. */
export const PLAYER_BORDER = 1
export const PLAYER_PADDING_LEFT = 12
export const PLAYER_PADDING_RIGHT = 14
/** Between the cover, the title column, the middle column and queue/volume. */
export const PLAYER_COLUMN_GAP = 14

export const PLAYER_COVER_SIZE = 48

/* The transport: shuffle, previous, play/pause, next, repeat. */
export const PLAYER_SHUFFLE_SIZE = 28
export const PLAYER_SKIP_SIZE = 30
export const PLAYER_PLAY_SIZE = 34
export const PLAYER_REPEAT_SIZE = 28
export const PLAYER_TRANSPORT_GAP = 6

/* The scrubber under it: elapsed, the waveform, duration. */
export const PLAYER_TIME_WIDTH = 34
export const PLAYER_SCRUBBER_GAP = 8
export const PLAYER_BAR_MIN_WIDTH = 1
export const PLAYER_BAR_GAP = 2

export const PLAYER_QUEUE_SIZE = 32
export const PLAYER_VOLUME_SIZE = 32
export const PLAYER_QUEUE_VOLUME_GAP = 2

/* The idle pill, with nothing loaded (#308): "Nothing playing", the Shuffle
 * library button and the space keycap. It fits inside the bar's width, so
 * it gives way by the same arithmetic, and Player.spec.tsx checks these the
 * same way. */
export const IDLE_HEIGHT = 52
/** Before "Nothing playing". Beside the button, either end, it's 8. */
export const IDLE_PADDING_TEXT = 16
export const IDLE_PADDING = 8
export const IDLE_GAP = 12
/** The button alone, as an icon: Button's 32px circle. */
export const IDLE_BUTTON_ICON_SIZE = 32

/* Text, measured in Chromium with Rubik and Sometype Mono and rounded up. */
/** "Nothing playing" at 13px (95.3). */
export const IDLE_SENTENCE_WIDTH = 96
/** The Shuffle library button with its icon and label (134.4). */
export const IDLE_BUTTON_WIDTH = 135
/** The "space" keycap (43.9). */
export const IDLE_SHORTCUT_WIDTH = 44
