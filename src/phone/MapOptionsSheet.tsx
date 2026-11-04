import type { ReactNode } from 'react'
import { Button } from '../ui/Button'
import { Chip } from '../ui/Chip'
import { SectionLabel } from '../ui/SectionLabel'
import { Slider } from '../ui/Slider'
import { Switch } from '../ui/Switch'
import { Tabs } from '../ui/Tabs'
import { TouchLayoutContext } from '../ui/touchLayout'
import type { MapPresetId } from '../canvas/mapPresets'
import type { MapPresetHistory } from '../hooks/useMapPresetHistory'
import type { Settings } from '../hooks/useSettings'
import { MAP_LAYOUTS, MAP_SLIDERS, MAP_SWITCHES, mapOptionDefaults } from '../panels/mapOptionSettings'
import { SHOW, isOn } from '../panels/mapShow'

/* The map options on the phone (#467): everything the desktop's popover
 * holds (panels/MapOptions.tsx), from the same settings, in the sheet.
 * The sliders button beside the chips over the map opens it as an overlay
 * (navigation.ts), at medium, so the map it changes stays in sight above
 * it; back, Escape or Done closes it.
 *
 * It's laid out for a finger, as the phone's Settings page is: the 40px
 * segmented layout control, the library tab's 32px chips, 52px rows with
 * the 51×31 switches, and sliders that take a touch 44px tall. On the
 * sheet's glass the rows sit between hairlines rather than on Settings'
 * solid cards, as node detail's lists do. */

type MapOptionsSheetProps = {
  settings: Settings
  updateSettings: (partial: Settings) => Promise<void>
  mapPresets: MapPresetHistory
}

/** The sheet's header while it shows the map options. */
export function MapOptionsHeader({ onDone }: { onDone: () => void }) {
  return (
    <div className="flex items-center justify-between gap-[12px] border-b border-[var(--color-line)] px-[20px] pb-[10px]">
      <div className="flex min-w-0 flex-col">
        <h2 className="text-title text-[var(--color-ink)]">Map options</h2>
        <span className="truncate text-secondary text-[var(--color-ink-2)]">saved for this library</span>
      </div>
      <button type="button" onClick={onDone} className="h-[44px] shrink-0 text-heading text-[var(--color-accent)]">
        Done
      </button>
    </div>
  )
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col">
      <SectionLabel className="pt-[20px] pb-[10px]">{label}</SectionLabel>
      {children}
    </section>
  )
}

export function MapOptionsBody({ settings, updateSettings, mapPresets }: MapOptionsSheetProps) {
  return (
    <TouchLayoutContext.Provider value={true}>
      <div className="flex flex-col px-[20px] pb-[24px]">
        <Group label="layout">
          <Tabs
            label="layout"
            size="xl"
            options={MAP_LAYOUTS}
            value={(mapPresets.activePreset ?? '') as MapPresetId}
            onChange={(id) => mapPresets.applyPreset(id)}
          />
        </Group>

        <Group label="show">
          {/* 32px chips, 12px apart down the rows, so each 44px target
           * meets the next without covering it. */}
          <div className="flex flex-wrap gap-x-[8px] gap-y-[12px]">
            {SHOW.map((item) => {
              const on = isOn(settings, item.key, item.defaultOn)
              return (
                <Chip key={item.key} size="lg" active={on} onClick={() => void updateSettings({ [item.key]: String(!on) })}>
                  {item.label}
                </Chip>
              )
            })}
          </div>
        </Group>

        <Group label="labels and layout">
          <div className="flex flex-col divide-y divide-[var(--color-line)] border-y border-[var(--color-line)]">
            {MAP_SWITCHES.map((item) => (
              <div key={item.key} className="flex min-h-[52px] items-center justify-between gap-[12px]">
                <span className="text-[16px] leading-[21px] text-[var(--color-ink)]">{item.label}</span>
                <Switch
                  size="xl"
                  checked={isOn(settings, item.key, item.defaultOn)}
                  onChange={(checked) => void updateSettings({ [item.key]: String(checked) })}
                  accessibilityLabel={item.label}
                />
              </div>
            ))}
          </div>
        </Group>

        <Group label="forces and sizes">
          {/* Each label sits closer to its own track than to the slider
           * above it: the 44px band centres the track 22px under it. */}
          <div className="flex flex-col gap-[10px]">
            {MAP_SLIDERS.map((slider) => (
              <div key={slider.key} className="flex flex-col">
                <span className="text-[16px] leading-[21px] text-[var(--color-ink)]">{slider.label}</span>
                <Slider
                  label={slider.label}
                  min={slider.min}
                  max={slider.max}
                  step={slider.step}
                  format={slider.format}
                  value={slider.value(settings)}
                  onChange={(v) => void updateSettings(slider.write(v))}
                />
              </div>
            ))}
          </div>
        </Group>

        <Button onClick={() => void updateSettings(mapOptionDefaults())} className="mt-[24px] self-start">
          Restore defaults
        </Button>
      </div>
    </TouchLayoutContext.Provider>
  )
}
