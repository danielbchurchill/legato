import { Icon } from '../ui/Icon'
import { Kbd } from '../ui/Kbd'
import { Tabs } from '../ui/Tabs'
import { Surface } from './Surface'
import { useShellLayout } from './layout'
import { MOD_KEY_LABEL } from './keys'

/* The top capsule: a glass pill centred over the free space, holding the
 * map/library switch and the way into search. Search used to be a field
 * buried in the left panel; it's the most-used action in the app, so it
 * lives here, one click or ⌘K from anywhere.
 *
 * The search half is a button, not a field: typing happens in the palette,
 * which opens over the same spot. */

export type ViewMode = 'map' | 'library'

const VIEWS = [
  { value: 'map', label: 'map', icon: 'map' },
  { value: 'library', label: 'library', icon: 'list' },
] as const satisfies readonly { value: ViewMode; label: string; icon: 'map' | 'list' }[]

type CapsuleProps = {
  view: ViewMode
  onViewChange: (view: ViewMode) => void
  onOpenSearch: () => void
  hidden: boolean
}

export function Capsule({ view, onViewChange, onOpenSearch, hidden }: CapsuleProps) {
  const layout = useShellLayout()
  return (
    <Surface
      className={`absolute top-[var(--inset)] z-20 flex h-[var(--capsule-height)] -translate-x-1/2 items-center gap-[10px] rounded-full pr-[8px] pl-[6px] transition-opacity duration-[var(--motion-fast)] ${
        hidden ? 'pointer-events-none opacity-0' : ''
      }`}
      style={{ left: layout.cx, width: layout.capsuleWidth }}
    >
      <Tabs label="view" variant="segmented" size="lg" options={VIEWS} value={view} onChange={onViewChange} />
      <span aria-hidden="true" className="h-[22px] w-px shrink-0 bg-[var(--color-line-strong)]" />
      <button
        type="button"
        onClick={onOpenSearch}
        aria-label="Search artists, albums, tracks"
        aria-keyshortcuts="Meta+K Control+K"
        className="flex h-full min-w-0 flex-1 items-center gap-[10px] text-left"
      >
        <Icon name="search" size={18} className="text-[var(--color-ink-2)]" />
        <span className="min-w-0 flex-1 truncate text-[length:var(--text-body)] text-[var(--color-ink-3)]">
          Search artists, albums, tracks
        </span>
        <Kbd>{MOD_KEY_LABEL}K</Kbd>
      </button>
    </Surface>
  )
}
