import { Chip } from '../ui/Chip'
import { Slider } from '../ui/Slider'
import { Switch } from '../ui/Switch'
import { Tabs } from '../ui/Tabs'
import { SectionLabel } from '../ui/SectionLabel'
import { Button } from '../ui/Button'
import type { MapPresetId } from '../canvas/mapPresets'
import type { MapPresetHistory } from '../hooks/useMapPresetHistory'
import type { Settings } from '../hooks/useSettings'
import { SHOW, isOn } from './mapShow'
import { MAP_LAYOUTS, MAP_SLIDERS, MAP_SWITCHES, mapOptionDefaults } from './mapOptionSettings'

/* The map options popover, opened from the map toolbar. It replaces the
 * shipped Music Map settings panel with the choices that change how the
 * map reads: a layout preset, which kinds of node to show, four switches,
 * and five sliders: three forces, node size and line width (#467).
 * Everything saves to the server's settings, so it's per library rather
 * than per device, and another device's change shows here as it's made.
 * The phone lays out the same options in a sheet (phone/MapOptionsSheet.tsx).
 *
 * Spacing and "pull of related music" are the presets' own axes: the repel
 * and link forces. Moving one, or gravity, off a preset leaves no preset
 * selected, rather than claiming a preset the map isn't in. */

type MapOptionsProps = {
  settings: Settings
  updateSettings: (partial: Settings) => Promise<void>
  mapPresets: MapPresetHistory
}

export function MapOptions({ settings, updateSettings, mapPresets }: MapOptionsProps) {
  return (
    <>
      <div className="flex items-baseline justify-between">
        <span className="text-heading text-[var(--color-ink)]">Map</span>
        <span className="text-small text-[var(--color-ink-3)]">saved for this library</span>
      </div>

      <div className="flex flex-col gap-[8px]">
        <SectionLabel>layout</SectionLabel>
        <Tabs
          label="layout"
          options={MAP_LAYOUTS}
          value={(mapPresets.activePreset ?? '') as MapPresetId}
          onChange={(id) => mapPresets.applyPreset(id)}
          className="self-start"
        />
      </div>

      <div className="flex flex-col gap-[8px]">
        <SectionLabel>show</SectionLabel>
        <div className="flex flex-wrap gap-[6px]">
          {SHOW.map((item) => {
            const on = isOn(settings, item.key, item.defaultOn)
            return (
              <Chip key={item.key} active={on} onClick={() => void updateSettings({ [item.key]: String(!on) })}>
                {item.label}
              </Chip>
            )
          })}
        </div>
      </div>

      <div className="flex flex-col gap-[10px]">
        {MAP_SWITCHES.map((item) => (
          <div key={item.key} className="flex items-center justify-between gap-[12px]">
            <span className="text-[length:var(--text-body)] leading-[20px] text-[var(--color-ink)]">{item.label}</span>
            <Switch
              checked={isOn(settings, item.key, item.defaultOn)}
              onChange={(checked) => void updateSettings({ [item.key]: String(checked) })}
              accessibilityLabel={item.label}
            />
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-[8px]">
        {MAP_SLIDERS.map((slider) => (
          <div key={slider.key} className="flex flex-col gap-[8px]">
            <SectionLabel>{slider.label}</SectionLabel>
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

      <Button onClick={() => void updateSettings(mapOptionDefaults())} className="self-start">
        Restore defaults
      </Button>
    </>
  )
}
