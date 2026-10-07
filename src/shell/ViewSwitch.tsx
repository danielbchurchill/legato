import { Tabs } from '../ui/Tabs'
import { Surface } from './Surface'

/* The map/library switch (issue #126 — see DESIGN.md "Library view").
 * Still the retired GraphToggle's Surface pill; what sits in it is Tabs'
 * segmented variant since the gpui-kit port — a raised thumb sliding to the
 * active view, with arrow keys that work — `bare`, since the glass pill is
 * already the well. The active label is still ink and the other muted-to-
 * control, DESIGN.md's active-state rule unchanged.
 *
 * Centered under the headers rather than GraphToggle's old fixed 69px (that
 * number was measured against the single continuous titlebar this app no
 * longer has, per AppShell.tsx's v2 note) — --header-height plus one
 * --spacing-lg step clears both LeftPanelHeader and RightPanelHeader
 * regardless of window width, which a fixed pixel wouldn't once the side
 * panels themselves start scaling past the 1440px reference. */

export type ViewMode = 'map' | 'library'

const VIEWS = [
  { value: 'map', label: 'map', icon: 'map' },
  { value: 'library', label: 'library', icon: 'list' },
] as const satisfies readonly { value: ViewMode; label: string; icon: 'map' | 'list' }[]

type ViewSwitchProps = {
  value: ViewMode
  onChange: (value: ViewMode) => void
}

export function ViewSwitch({ value, onChange }: ViewSwitchProps) {
  return (
    <Surface
      className="absolute top-[calc(var(--header-height)+var(--spacing-lg))] left-1/2 h-[41px] -translate-x-1/2 overflow-hidden"
      style={{ zIndex: 10 }}
    >
      <div className="flex h-full items-center px-[3px]">
        <Tabs label="view" variant="segmented" bare size="lg" options={VIEWS} value={value} onChange={onChange} />
      </div>
    </Surface>
  )
}
