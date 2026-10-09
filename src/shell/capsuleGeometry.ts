/* The capsule's horizontal sizes, in px, for the same reason the player's
 * are in playerGeometry.ts: Capsule.tsx draws with them, and layout.ts's
 * capsuleContentWidth adds them up to decide which parts fit (#308).
 * Capsule.spec.tsx checks that what's drawn carries them. */

/** The `glass` utility's border (index.css), on each side. */
export const CAPSULE_BORDER = 1
export const CAPSULE_PADDING_LEFT = 6
export const CAPSULE_PADDING_RIGHT = 8
/** Between the map/library switch, the divider and the search field. */
export const CAPSULE_GAP = 10
export const CAPSULE_DIVIDER_WIDTH = 1

/* The search field: the magnifier, the placeholder and the keycap, with
 * padding after the last of them. */
export const CAPSULE_SEARCH_ICON_SIZE = 18
export const CAPSULE_SEARCH_GAP = 10
export const CAPSULE_SEARCH_PADDING_RIGHT = 10

/* The rest is text, so it was measured rather than added up: Chromium,
 * Rubik and Sometype Mono as self-hosted, rounded up to the next pixel. */

/** The map/library switch with its labels: Tabs at `lg`, segments of 14px
 * padding, an 18px icon and a 6px gap around "map" (27.1) and "library"
 * (40.5), in a 2px well with 2px between them. */
export const CAPSULE_SWITCH_WIDTH = 178
/** The switch's icons alone: two 32px square segments in the same well. */
export const CAPSULE_SWITCH_ICONS_WIDTH = 2 + 32 + 2 + 32 + 2
/** "Search artists, albums, tracks" at 14px (192.2). */
export const CAPSULE_PLACEHOLDER_WIDTH = 193
/** "Search" at 14px (45.7). */
export const CAPSULE_SEARCH_WORD_WIDTH = 46
/** The keycap as "Ctrl K" (50.3), outside a Mac. A Mac's "⌘K" is 25, but
 * one width keeps the thresholds the same on every platform. */
export const CAPSULE_SHORTCUT_WIDTH = 51
