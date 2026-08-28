import type { Granularity } from '../shell/granularity'

/* Client-side half of DESIGN.md's "Edge palette" -> "v2: user-colorable
 * types". Which types belong to which granularity's graph mirrors
 * server/src/routes/nodes.ts's EDGE_TYPES_BY_GRANULARITY — kept in sync by
 * hand, the same tradeoff EDGE_COLOR below already accepts against
 * tokens.css's --color-edge-* (sigma renders to WebGL and never sees CSS,
 * so Canvas.tsx needs these as concrete hex too — imported from here rather
 * than each file keeping its own copy). */

/* One family, identical saturation and lightness at every hue — see
 * DESIGN.md "Edge palette". Grouped by which graph a type actually renders
 * in (they never render together), not spaced as one flat 10-color wheel. */
export const EDGE_COLOR: Record<string, string> = {
  performed_by: '#bf68eb',
  appears_on: '#68b6eb',
  released_in: '#68eb79',
  featured_artist: '#66eabc',
  released_on: '#ea66a6',
  produced_by: '#ea9066',
  engineered_by: '#dbea66',
  same_artist: '#7166ea',
  same_label: '#ea667c',
  collaborated_with: '#ea8766',
}

export type EdgeTypeInfo = { type: string; label: string; defaultHex: string }

const LABELS: Record<string, string> = {
  performed_by: 'performed by',
  appears_on: 'appears on',
  released_in: 'released in',
  featured_artist: 'featured artist',
  released_on: 'released on',
  produced_by: 'produced by',
  engineered_by: 'engineered by',
  same_artist: 'same artist',
  same_label: 'same label',
  collaborated_with: 'collaborated',
}

const TYPES_BY_GRANULARITY: Record<Granularity, string[]> = {
  tracks: ['performed_by', 'appears_on', 'released_in', 'featured_artist', 'released_on', 'produced_by', 'engineered_by'],
  albums: ['same_artist', 'same_label'],
  artists: ['collaborated_with'],
}

export function edgeTypesForGranularity(granularity: Granularity): EdgeTypeInfo[] {
  return TYPES_BY_GRANULARITY[granularity].map((type) => ({
    type,
    label: LABELS[type],
    defaultHex: EDGE_COLOR[type],
  }))
}

const EDGE_COLOR_SETTING_PREFIX = 'edgeColor:'

export function edgeColorSettingKey(type: string): string {
  return `${EDGE_COLOR_SETTING_PREFIX}${type}`
}

/** All `edgeColor:*` overrides in the settings store, keyed back down to a
 * plain type -> hex map — what Canvas.tsx's edgeReducer needs live. Reads
 * every type at once rather than one key per granularity, since edge types
 * never collide across granularities (see TYPES_BY_GRANULARITY above), so
 * there's nothing to scope this to the active graph. */
export function resolveEdgeColorOverrides(settings: Record<string, string>): Record<string, string> {
  const overrides: Record<string, string> = {}
  for (const [key, value] of Object.entries(settings)) {
    if (key.startsWith(EDGE_COLOR_SETTING_PREFIX)) overrides[key.slice(EDGE_COLOR_SETTING_PREFIX.length)] = value
  }
  return overrides
}

/* The curated hue set the per-type color picker offers, in place of a free
 * wheel — DESIGN.md is explicit that an unconstrained picker would let a
 * user pick two types into near-identical hues, defeating the whole point
 * of the spacing work the fixed palette already did. Eight hues, evenly
 * spaced at 45°, is the largest evenly-spaced set where any two DISTINCT
 * choices are still guaranteed at least 45° apart — close to the ~44°
 * clearance the fixed palette's own 7-type tracks graph was designed
 * against (see DESIGN.md "Edge palette"). Same 76%/66% saturation/lightness
 * as every fixed hue, so a custom pick reads as a peer, not a different
 * kind of color. */
const CURATED_HUE_COUNT = 8
const CURATED_SATURATION = 0.76
const CURATED_LIGHTNESS = 0.66

function hslToHex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l)
  const channel = (n: number) => {
    const k = (n + h / 30) % 12
    const value = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    return Math.round(255 * value)
      .toString(16)
      .padStart(2, '0')
  }
  return `#${channel(0)}${channel(8)}${channel(4)}`
}

export const CURATED_EDGE_HUES: { hue: number; hex: string }[] = Array.from({ length: CURATED_HUE_COUNT }, (_, i) => {
  const hue = (i * 360) / CURATED_HUE_COUNT
  return { hue, hex: hslToHex(hue, CURATED_SATURATION, CURATED_LIGHTNESS) }
})

function hexToHue(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16)
  const r = ((n >> 16) & 255) / 255
  const g = ((n >> 8) & 255) / 255
  const b = (n & 255) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  if (d === 0) return 0
  let h: number
  if (max === r) h = ((g - b) / d) % 6
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  h *= 60
  return h < 0 ? h + 360 : h
}

const MIN_HUE_CLEARANCE_DEG = 30

function circularHueDistance(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360
  return Math.min(diff, 360 - diff)
}

/** True if picking `candidateHex` would land within MIN_HUE_CLEARANCE_DEG of
 * a hex some other type in the same graph is already using — the guard that
 * keeps the curated set from being used to defeat its own spacing. */
export function isHueTooClose(candidateHex: string, takenHexes: string[]): boolean {
  const candidateHue = hexToHue(candidateHex)
  return takenHexes.some((hex) => circularHueDistance(candidateHue, hexToHue(hex)) < MIN_HUE_CLEARANCE_DEG)
}
