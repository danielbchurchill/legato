import type { Settings } from '../hooks/useSettings'
import {
  BALANCED_FORCE_SETTINGS,
  MAP_PRESET_IDS,
  MAP_PRESET_LABELS,
  forceSettingsFromSettings,
  forceSettingsToPartialSettings,
} from '../canvas/mapPresets'
import { nodeSizeScale, nodeSizeSettings } from '../canvas/nodeTypes'
import { EDGE_WIDTH_SCALE_DEFAULT, EDGE_WIDTH_SCALE_KEY, resolveEdgeWidthScale } from '../canvas/edgeWidth'
import { EDGE_COLOR_SETTING_PREFIX } from '../canvas/edgeTypes'
import { SHOW } from './mapShow'

/* What the map options hold, apart from how they're drawn: the desktop's
 * popover (MapOptions.tsx) and the phone's sheet (phone/MapOptionsSheet.tsx)
 * both lay these out, so the two can't offer different maps (#467).
 *
 * Everything here is a server setting, per library rather than per device,
 * and useSettings applies another device's change to them as it happens
 * (isSharedMapSetting), so a phone can tune the map a desktop shows. */

/** The layout presets, as the segmented control's options. */
export const MAP_LAYOUTS = MAP_PRESET_IDS.map((id) => ({ value: id, label: MAP_PRESET_LABELS[id] }))

export const MAP_SWITCHES = [
  { key: 'showArtistLabels', label: 'Artist labels', defaultOn: true },
  // #467: producer and engineer nodes with their names off. On by default,
  // as their labels always were.
  { key: 'showCreditLabels', label: 'Producer labels', defaultOn: true },
  { key: 'colourEdgesByType', label: 'Colour edges by type', defaultOn: false },
  { key: 'nodePositionsLocked', label: 'Lock layout', defaultOn: false },
] as const

export type MapSlider = {
  key: string
  label: string
  min: number
  max: number
  step: number
  value: (settings: Settings) => number
  /** The settings a move to `value` writes, formatted as the slider steps. */
  write: (value: number) => Settings
  /** The thumb's readout, when the plain value doesn't say it. */
  format?: (value: number) => string
}

const times = (value: number) => `${value.toFixed(2)}×`

/* Spacing and the pull of related music are the presets' own axes (repel
 * and link strength). Gravity is the pull toward the middle of the map:
 * every preset holds it at balanced's 0.03, so moving it off that leaves no
 * preset selected, as the other two do. Its top is well past where the
 * map starts to crowd in on itself. Node size and line width only change
 * what's drawn, so a move never starts the physics. */
export const MAP_SLIDERS: readonly MapSlider[] = [
  {
    key: 'forceRepelStrength',
    label: 'spacing',
    min: 0,
    max: 200,
    step: 1,
    value: (s) => forceSettingsFromSettings(s).forceRepelStrength,
    write: (v) => ({ forceRepelStrength: v.toFixed(0) }),
  },
  {
    key: 'forceLinkStrength',
    label: 'pull of related music',
    min: 0,
    max: 1,
    step: 0.01,
    value: (s) => forceSettingsFromSettings(s).forceLinkStrength,
    write: (v) => ({ forceLinkStrength: v.toFixed(2) }),
  },
  {
    key: 'forceCenterStrength',
    label: 'gravity',
    min: 0,
    max: 0.2,
    step: 0.01,
    value: (s) => forceSettingsFromSettings(s).forceCenterStrength,
    write: (v) => ({ forceCenterStrength: v.toFixed(2) }),
  },
  {
    key: 'nodeSize',
    label: 'node size',
    min: 0.5,
    max: 2,
    step: 0.05,
    value: nodeSizeScale,
    write: nodeSizeSettings,
    format: times,
  },
  {
    key: EDGE_WIDTH_SCALE_KEY,
    label: 'line width',
    min: 0.5,
    max: 3,
    step: 0.05,
    value: resolveEdgeWidthScale,
    write: (v) => ({ [EDGE_WIDTH_SCALE_KEY]: v.toFixed(2) }),
    format: times,
  },
]

/** Restore defaults: the balanced layout, the default show chips and
 * switches, and every slider back where a new library starts. One write,
 * so another device sees it land at once. */
export function mapOptionDefaults(): Settings {
  const defaults: Settings = { ...forceSettingsToPartialSettings(BALANCED_FORCE_SETTINGS) }
  for (const item of [...SHOW, ...MAP_SWITCHES]) defaults[item.key] = String(item.defaultOn)
  Object.assign(defaults, nodeSizeSettings(1))
  defaults[EDGE_WIDTH_SCALE_KEY] = EDGE_WIDTH_SCALE_DEFAULT.toFixed(2)
  return defaults
}

const SHARED_KEYS: ReadonlySet<string> = new Set([
  ...SHOW.map((item) => item.key),
  ...MAP_SWITCHES.map((item) => item.key),
  ...Object.keys(forceSettingsToPartialSettings(BALANCED_FORCE_SETTINGS)),
  EDGE_WIDTH_SCALE_KEY,
])

/** Whether a setting is one of the map's, which another device's change
 * reaches live (useSettings). The rest wait for a reload as they always
 * have: the map/library switch, repeat or an output device changing on
 * this screen because someone moved it on another would be a surprise. */
export function isSharedMapSetting(key: string): boolean {
  return SHARED_KEYS.has(key) || key.startsWith('nodeSize:') || key.startsWith(EDGE_COLOR_SETTING_PREFIX)
}
