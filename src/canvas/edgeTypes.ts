/* Client-side half of DESIGN.md's "Edge palette" -> "v2: user-colorable
 * types". EDGE_COLOR is kept in sync by hand against
 * server/src/routes/nodes.ts's EDGE_TYPES (the same tradeoff this file
 * already accepts against tokens.css's --color-edge-* — sigma renders to
 * WebGL and never sees CSS, so Canvas.tsx needs these as concrete hex too,
 * imported from here rather than each file keeping its own copy).
 *
 * 2026-08-29: the three granularities collapsed into one combined graph
 * (Legato.md), so there is no more per-graph type list — every real
 * relationship edge renders together now. same_artist/same_label/
 * collaborated_with (entities/collaboration.ts's derived edges, once these
 * granularities' own distinguishing feature) are deliberately NOT among
 * them any more: they still exist in the DB and power real features
 * (similarity, facts, generated articles), they just never belonged to a
 * *drawn* graph edge — an artist's whole catalogue pairwise-connected by
 * same_artist rendered as a dense, unreadable mesh even in the old
 * albums-only view, and the combined graph already has the real hierarchy
 * edges to cluster an artist's tracks near that artist node without one. */

/* One family, identical saturation and lightness at every hue — see
 * DESIGN.md "Edge palette". These 7 are DESIGN.md's original "tracks
 * graph" set, spaced ≥44° apart specifically so they read as distinct
 * co-rendering in one view — which is now just *the* view, not one of
 * three. performed_credit/mixed_by are real edge types too (routes/nodes.ts
 * EDGE_TYPES) but have no curated slot here yet — nine hues won't fit this
 * set's ≥44°-clearance rule without reworking the other seven's spacing
 * too (DESIGN.md's own "revisit when edge types widen" — a real design
 * pass, not something to squeeze in here). They render via
 * EDGE_COLOR_FALLBACK below, same as they already do in production today.
 * member_of (issue #61, band membership between two artist nodes) joins
 * them on the same basis — deliberately left out of the curated set rather
 * than treated as a drive-by tenth hue. */
export const EDGE_COLOR: Record<string, string> = {
  performed_by: '#bf68eb',
  appears_on: '#68b6eb',
  released_in: '#68eb79',
  featured_artist: '#66eabc',
  released_on: '#ea66a6',
  produced_by: '#ea9066',
  engineered_by: '#dbea66',
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
}

/* The color picker only offers types with a real curated default above —
 * performed_credit/mixed_by/member_of still draw on canvas (via
 * EDGE_COLOR_FALLBACK), they just have nothing to seed a picker swatch
 * from yet. */
export function edgeTypes(): EdgeTypeInfo[] {
  return Object.keys(EDGE_COLOR).map((type) => ({
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
 * plain type -> hex map — what Canvas.tsx's edgeReducer needs live. */
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
 * of the spacing work the fixed palette already did.
 *
 * The 7 fixed defaults already sit at real-world gaps of 44-84° around the
 * circle (see DESIGN.md "Edge palette"), not evenly spaced — so a picker
 * built on a coarse 8-anchor/45°-pitch grid with a 30° exclusion radius
 * around every *other* type's current hue left three of the seven types
 * (released_in, featured_artist, produced_by) with zero non-disabled
 * swatches: every anchor happened to land inside some other type's
 * exclusion band. Confirmed against the real EDGE_COLOR defaults, not a
 * hypothetical — the picker was unusable for those types, not just tight.
 * 16 anchors at 22.5° pitch with a tighter 20° exclusion radius leaves
 * every type at least 6 of 16 real, non-disabled choices (same check,
 * scripted against EDGE_COLOR). Still a curated grid, still guards against
 * an indistinguishable pick — just fine-grained enough that the existing
 * defaults' uneven spacing can't blank out a type's entire picker. */
const CURATED_HUE_COUNT = 16
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

const MIN_HUE_CLEARANCE_DEG = 20

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
