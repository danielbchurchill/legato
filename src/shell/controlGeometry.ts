/* The shared controls' sizes, in px, that layout.ts adds up for the capsule
 * and the idle pill (#308): Tabs at `lg` (the map/library switch), Button at
 * `md` with an icon (Shuffle library) and Kbd (both keycaps).
 *
 * These are Tailwind classes in src/ui, and they have to stay classes there,
 * so each one is written twice: as the class, and here. Capsule.spec.tsx and
 * Player.spec.tsx render the controls and check that what's drawn carries
 * every size below, so changing one without the other fails a spec rather
 * than clipping a pill. */

/** Tabs, segmented: the well's padding (`p-[2px]`) and the gap between its
 * segments (`gap-[2px]`). */
export const TABS_WELL_PADDING = 2
export const TABS_SEGMENT_GAP = 2
/** Tabs at `lg`: a labelled segment's padding either side (`px-[14px]`), its
 * 18px icon, and the gap from the icon to the label (`gap-[6px]`). */
export const TABS_LG_PADDING = 14
export const TABS_LG_ICON_SIZE = 18
export const TABS_ICON_GAP = 6
/** Tabs at `lg`: an icon alone, in a square segment (`size-[32px]`). */
export const TABS_LG_SQUARE = 32

/** Button at `md`: 32px tall (`h-[32px]`), so an icon alone is a 32px
 * circle. With an icon and a label: 10px before the 16px icon, 6px to the
 * label and 14px after it (`pl-[10px] pr-[14px]`, `gap-[6px]`). */
export const BUTTON_MD_HEIGHT = 32
export const BUTTON_ICON_SIZE = 16
export const BUTTON_ICON_GAP = 6
export const BUTTON_PADDING_LEFT = 10
export const BUTTON_PADDING_RIGHT = 14

/** Kbd: a 1px border (`border`) and 5px of padding (`px-[5px]`) either side
 * of the key's name. */
export const KBD_BORDER = 1
export const KBD_PADDING = 5
