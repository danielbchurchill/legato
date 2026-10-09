import { Icon, type IconName } from '../ui/Icon'
import { Kbd } from '../ui/Kbd'
import { Tabs } from '../ui/Tabs'
import { Surface } from './Surface'
import { useShellLayout } from './layout'
import { MOD_KEY_LABEL } from './keys'
import {
  CAPSULE_DIVIDER_WIDTH,
  CAPSULE_GAP,
  CAPSULE_PADDING_LEFT,
  CAPSULE_PADDING_RIGHT,
  CAPSULE_SEARCH_GAP,
  CAPSULE_SEARCH_ICON_SIZE,
  CAPSULE_SEARCH_PADDING_RIGHT,
} from './capsuleGeometry'

/* The top capsule: a glass pill centred over the free space, holding the
 * map/library switch and the way into search. Search used to be a field
 * buried in the left panel; it's the most-used action in the app, so it
 * lives here, one click or ⌘K from anywhere.
 *
 * The search half is a button, not a field: typing happens in the palette,
 * which opens over the same spot.
 *
 * The keycap sits 14px inside the pill's top and bottom (48 tall, 20 tall).
 * The button's 10px right padding, on top of the pill's 8px and its border,
 * keeps it 14px from the rounded end too: its 5px corner lands on the end's
 * own centre, 24px in, so it clears the curve evenly instead of tucking into
 * it (#286). Padding on the button rather than the pill keeps the click
 * target running to the end.
 *
 * As the free space narrows, the placeholder shortens to "Search", then the
 * keycap, the word and the switch's labels go, in the order layout.ts sets
 * out (#308). The switch and the search button never go, and a tab without
 * its label shows it in a tooltip.
 *
 * The pill clips sideways, as the player's bar does, so a label an engine
 * draws wider than Chromium measured it is cut off at the pill's edge rather
 * than spilling past it. Only sideways: the search button runs the pill's
 * full height, and its focus ring sits 3px outside it. */

export type ViewMode = 'map' | 'library'

const VIEWS = [
  { value: 'map', label: 'map', icon: 'map' },
  { value: 'library', label: 'library', icon: 'library' },
] as const satisfies readonly { value: ViewMode; label: string; icon: IconName }[]

type CapsuleProps = {
  view: ViewMode
  onViewChange: (view: ViewMode) => void
  onOpenSearch: () => void
  hidden: boolean
}

export function Capsule({ view, onViewChange, onOpenSearch, hidden }: CapsuleProps) {
  const layout = useShellLayout()
  const parts = layout.capsuleParts
  return (
    <Surface
      className={`absolute top-[var(--inset)] z-20 flex h-[var(--capsule-height)] -translate-x-1/2 items-center overflow-x-clip rounded-full transition-opacity duration-[var(--motion-fast)] ${
        hidden ? 'pointer-events-none opacity-0' : ''
      }`}
      style={{
        left: layout.capsuleCx,
        width: layout.capsuleWidth,
        gap: CAPSULE_GAP,
        paddingLeft: CAPSULE_PADDING_LEFT,
        paddingRight: CAPSULE_PADDING_RIGHT,
      }}
    >
      <Tabs
        label="view"
        variant="segmented"
        size="lg"
        iconOnly={!parts.switchLabels}
        options={VIEWS}
        value={view}
        onChange={onViewChange}
      />
      <span aria-hidden="true" className="h-[22px] shrink-0 bg-[var(--color-line-strong)]" style={{ width: CAPSULE_DIVIDER_WIDTH }} />
      <button
        type="button"
        onClick={onOpenSearch}
        aria-label="Search artists, albums, tracks"
        aria-keyshortcuts="Meta+K Control+K"
        className="flex h-full min-w-0 flex-1 items-center text-left"
        style={{ gap: CAPSULE_SEARCH_GAP, paddingRight: CAPSULE_SEARCH_PADDING_RIGHT }}
      >
        <Icon name="search" size={CAPSULE_SEARCH_ICON_SIZE} className="text-[var(--color-ink-2)]" />
        {parts.searchLabel && (
          <span className="min-w-0 flex-1 truncate text-[length:var(--text-body)] text-[var(--color-ink-3)]">
            {parts.searchLabel === 'full' ? 'Search artists, albums, tracks' : 'Search'}
          </span>
        )}
        {parts.searchShortcut && <Kbd>{MOD_KEY_LABEL}K</Kbd>}
      </button>
    </Surface>
  )
}
