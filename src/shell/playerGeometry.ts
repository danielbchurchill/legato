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
