import type { Ref } from 'react'
import { Icon } from '../ui/Icon'
import { SHOW, isOn, type ShowKey } from '../panels/mapShow'
import type { Settings } from '../hooks/useSettings'

/* What floats over the map on the phone (#389, Legato Mobile v2 "Floating
 * over the map"): the search capsule with the settings button beside it,
 * and the node-type chips under them, led by the map options button
 * (#467). They start 6px under the status bar, 16px in
 * from each side, and fade away as the sheet comes up to large, where the
 * sheet's own dim covers the map. */

/* The handoff's labels, and each type's colour on the map. The chips show
 * and hide the same node types the desktop's map options do: the same
 * settings, so the map is the same on both. */
const CHIP: Record<ShowKey, { label: string; color: string }> = {
  showArtists: { label: 'artists', color: 'var(--color-node-artist)' },
  showReleases: { label: 'albums', color: 'var(--color-node-release)' },
  showTracks: { label: 'tracks', color: 'var(--color-node-recording)' },
  showCreditNodes: { label: 'credits', color: 'var(--color-node-credit)' },
}

/* How far under the status bar the controls end (6 + 48 + 10 + 32), and
 * 16px more: where anything laid out on the map under them starts. The
 * map's camera keeps what it fits below this. */
export const MAP_CONTROLS_CLEARANCE = 112

type MapControlsProps = {
  settings: Settings
  updateSettings: (partial: Settings) => Promise<void>
  onOpenSearch: () => void
  onOpenSettings: () => void
  /** The rest of the map options, in the sheet (MapOptionsSheet.tsx). */
  onOpenMapOptions: () => void
  /** While the sheet is large they're gone: out of reach and out of the tab
   * order. */
  hidden: boolean
  ref?: Ref<HTMLDivElement>
}

export function MapControls({ settings, updateSettings, onOpenSearch, onOpenSettings, onOpenMapOptions, hidden, ref }: MapControlsProps) {
  return (
    <div
      ref={ref}
      inert={hidden}
      className="absolute inset-x-[16px] top-[calc(env(safe-area-inset-top)+6px)] z-10 flex flex-col gap-[10px]"
    >
      <div className="flex gap-[10px]">
        {/* Glass with the small shadow, as the handoff draws both. */}
        <button
          type="button"
          onClick={onOpenSearch}
          className="glass flex h-[48px] min-w-0 flex-1 items-center gap-[10px] rounded-[24px] px-[16px] text-left"
          style={{ boxShadow: 'var(--shadow-sm)' }}
        >
          <Icon name="search" size={20} className="shrink-0 text-[var(--color-ink-2)]" />
          <span className="truncate text-[15px] leading-[20px] text-[var(--color-ink-3)]">Search artists, albums, people</span>
        </button>
        <button
          type="button"
          aria-label="Settings"
          onClick={onOpenSettings}
          className="glass grid size-[48px] shrink-0 place-items-center rounded-full text-[var(--color-ink-2)]"
          style={{ boxShadow: 'var(--shadow-sm)' }}
        >
          <Icon name="settings" size={20} />
        </button>
      </div>
      {/* Out to the screen's right edge, so the row runs off it as a row
       * that scrolls does. */}
      <div className="-mr-[16px] flex items-center gap-[6px]">
        {/* Leading the row and pinned there, as a filter button leads a row
         * of filter chips: the chips' flat glass and height, round, in a
         * 44px target, with the desktop toolbar's own sliders glyph. */}
        <button
          type="button"
          aria-label="Map options"
          onClick={onOpenMapOptions}
          className="glass relative grid size-[32px] shrink-0 place-items-center rounded-full text-[var(--color-ink)] before:absolute before:-inset-[6px] before:content-['']"
          style={{ boxShadow: 'none' }}
        >
          <Icon name="sliders" size={16} />
        </button>
        {/* The chips scroll sideways where a phone can't fit all four
         * beside the button: 390px leaves the last few pixels of the
         * fourth past the edge. Padded so each chip's 44px target isn't
         * clipped. */}
        <div
          role="group"
          aria-label="Show on the map"
          className="scrollbar-none -my-[6px] flex min-w-0 flex-1 gap-[6px] overflow-x-auto py-[6px] pr-[16px]"
        >
          {SHOW.map(({ key, defaultOn }) => {
            const on = isOn(settings, key, defaultOn)
            return (
              <button
                key={key}
                type="button"
                aria-pressed={on}
                onClick={() => void updateSettings({ [key]: String(!on) })}
                // 32px tall, inside a 44px target. No shadow: the handoff's
                // chips are flat glass.
                className={`glass relative inline-flex h-[32px] shrink-0 items-center gap-[6px] rounded-[16px] px-[12px] text-secondary font-medium whitespace-nowrap before:absolute before:inset-x-0 before:-inset-y-[6px] before:content-[''] ${
                  on ? 'text-[var(--color-ink)]' : 'text-[var(--color-ink-2)]'
                }`}
                style={{ boxShadow: 'none' }}
              >
                <span aria-hidden="true" className="size-[8px] rounded-full" style={{ background: CHIP[key].color }} />
                {CHIP[key].label}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
