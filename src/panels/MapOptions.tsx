import { Chip } from '../ui/Chip'
import { Slider } from '../ui/Slider'
import { Switch } from '../ui/Switch'
import { Tabs } from '../ui/Tabs'
import { SectionLabel } from '../ui/SectionLabel'
import { Button } from '../ui/Button'
import { MAP_PRESET_IDS, MAP_PRESET_LABELS, type MapPresetId } from '../canvas/mapPresets'
import type { MapPresetHistory } from '../hooks/useMapPresetHistory'
import type { Settings } from '../hooks/useSettings'

/* The map options popover, opened from the map toolbar. It replaces the
 * shipped Music Map settings panel with the handful of choices that change
 * how the map reads: a layout preset, which kinds of node to show, three
 * switches and two forces. Everything saves to the server's settings, so
 * it's per library rather than per device.
 *
 * The two sliders are the presets' own axes: spacing is the repel force,
 * "pull of related music" the link force. Moving one off a preset leaves
 * no preset selected, rather than claiming a preset the map isn't in. */

const LAYOUTS = MAP_PRESET_IDS.map((id) => ({ value: id, label: MAP_PRESET_LABELS[id] }))

/* The "show" chips. Producers are stored under their older key: hiding
 * them takes them out of the physics as well, which the other three don't. */
const SHOW = [
  { key: 'showArtists', label: 'artists', defaultOn: true },
  { key: 'showReleases', label: 'albums', defaultOn: true },
  { key: 'showTracks', label: 'tracks', defaultOn: true },
  { key: 'showCreditNodes', label: 'producers', defaultOn: false },
] as const

const SWITCHES = [
  { key: 'showArtistLabels', label: 'Artist labels', defaultOn: true },
  { key: 'colourEdgesByType', label: 'Colour edges by type', defaultOn: false },
  { key: 'nodePositionsLocked', label: 'Lock layout', defaultOn: false },
] as const

function isOn(settings: Settings, key: string, defaultOn: boolean): boolean {
  const raw = settings[key]
  return raw == null ? defaultOn : raw === 'true'
}

type MapOptionsProps = {
  settings: Settings
  updateSettings: (partial: Settings) => Promise<void>
  mapPresets: MapPresetHistory
}

export function MapOptions({ settings, updateSettings, mapPresets }: MapOptionsProps) {
  const { current } = mapPresets

  const restoreDefaults = () => {
    mapPresets.restoreDefaults()
    const defaults: Settings = {}
    for (const item of [...SHOW, ...SWITCHES]) defaults[item.key] = String(item.defaultOn)
    void updateSettings(defaults)
  }

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
          options={LAYOUTS}
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
        {SWITCHES.map((item) => (
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
        <SectionLabel>spacing</SectionLabel>
        <Slider
          label="spacing"
          min={0}
          max={200}
          step={1}
          value={current.forceRepelStrength}
          onChange={(v) => void updateSettings({ forceRepelStrength: v.toFixed(0) })}
        />
        <SectionLabel>pull of related music</SectionLabel>
        <Slider
          label="pull of related music"
          min={0}
          max={1}
          step={0.01}
          value={current.forceLinkStrength}
          onChange={(v) => void updateSettings({ forceLinkStrength: v.toFixed(2) })}
        />
      </div>

      <Button onClick={restoreDefaults} className="self-start">
        Restore defaults
      </Button>
    </>
  )
}
