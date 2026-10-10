import type { ReactNode } from 'react'
import whiteLogoSrc from '../assets/brand/white-logo.png'
import blackLogoSrc from '../assets/brand/black-logo.png'
import { Icon } from '../ui/Icon'
import { Tooltip } from '../ui/Tooltip'
import { TooltipGroup } from '../ui/TooltipGroup'
import type { ResolvedTheme } from '../hooks/useTheme'
import { Surface } from './Surface'
import { RAIL_ITEMS, SETTINGS_ITEM, type RailItem } from './panels'
import { railButtonClass } from './railButton'

/* The rail: a 56px glass column floating 12px in from the window's left edge,
 * full height. The logo, then the two library destinations, then — pushed to
 * the bottom — the connection indicator (#118), settings and the avatar.
 *
 * Clicking an item toggles its panel. The item stays lit for any page under
 * it (one playlist, one worklist), so the rail always says where you are.
 *
 * The logo is a real vendored PNG rather than type, which is why this one
 * component needs to know the theme. */

type RailProps = {
  active: RailItem | null
  onToggle: (item: RailItem) => void
  theme: ResolvedTheme
  initials: string
  accountLabel: string
  /** Drawn above Settings: the connection indicator (ConnectionIndicator.tsx). */
  status?: ReactNode
}

function RailButton({
  icon,
  label,
  active,
  onClick,
}: {
  icon: Parameters<typeof Icon>[0]['name']
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <Tooltip label={label} placement="right">
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        aria-pressed={active}
        className={railButtonClass(active)}
      >
        <Icon name={icon} size={22} />
      </button>
    </Tooltip>
  )
}

export function Rail({ active, onToggle, theme, initials, accountLabel, status }: RailProps) {
  return (
    <Surface
      role="navigation"
      aria-label="Panels"
      className="absolute top-[var(--inset)] bottom-[var(--inset)] left-[var(--inset)] z-20 flex w-[var(--rail-width)] flex-col items-center gap-[6px] rounded-[var(--radius-rail)] py-[10px]"
    >
      {/* The drag region for a frameless window sits on the logo, the one
       * part of the rail that isn't a control. */}
      <img
        data-tauri-drag-region
        src={theme === 'light' ? blackLogoSrc : whiteLogoSrc}
        alt="legato"
        draggable={false}
        className="mb-[10px] size-[32px] select-none"
      />
      <TooltipGroup>
        {RAIL_ITEMS.map((item) => (
          <RailButton key={item.id} icon={item.icon} label={item.label} active={active === item.id} onClick={() => onToggle(item.id)} />
        ))}
        <span className="flex-1" />
        {status}
        <RailButton
          icon={SETTINGS_ITEM.icon}
          label={SETTINGS_ITEM.label}
          active={active === 'settings'}
          onClick={() => onToggle('settings')}
        />
        <Tooltip label={accountLabel} placement="right">
          <button
            type="button"
            onClick={() => onToggle('settings')}
            aria-label={`${accountLabel}, open settings`}
            className="mt-[4px] grid size-[30px] shrink-0 place-items-center rounded-full bg-[var(--color-raised)] text-[11px] font-medium text-[var(--color-ink)]"
          >
            {initials}
          </button>
        </Tooltip>
      </TooltipGroup>
    </Surface>
  )
}
