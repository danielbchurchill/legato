/* The capsule's horizontal sizes, in px, for the same reason the player's
 * are in playerGeometry.ts: Capsule.tsx draws with them, and layout.ts's
 * capsuleContentWidth adds them up to decide which parts fit (#308).
 * Capsule.spec.tsx checks that what's drawn carries them. The switch and the
 * keycap are shared controls, whose sizes are in controlGeometry.ts. */

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

/** The switch's labels, "map" (27.1) and "library" (40.5), at 13px. */
export const CAPSULE_MAP_LABEL_WIDTH = 28
export const CAPSULE_LIBRARY_LABEL_WIDTH = 41
/** "Search artists, albums, tracks" at 14px (192.5). */
export const CAPSULE_PLACEHOLDER_WIDTH = 193
/** "Search" at 14px (45.7). */
export const CAPSULE_SEARCH_WORD_WIDTH = 46
/** The keycap's "Ctrl K" (38.3), outside a Mac. A Mac's "⌘K" is 13, but one
 * width keeps the thresholds the same on every platform. */
export const CAPSULE_SHORTCUT_TEXT_WIDTH = 39
