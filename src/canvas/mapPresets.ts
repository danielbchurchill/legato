import type { Settings } from '../hooks/useSettings'

/* #127: clusters / balanced / sprawl. A named bundle over the same four
 * settings keys MusicMapSettings.tsx's "forces" group and "links > distance"
 * row already expose — no new physics, no new setting keys, just three
 * fixed points along sliders that already exist (see that file's own
 * `parseMultiplier` calls for the same four keys and defaults this module
 * centralizes).
 *
 * Only forceLinkStrength and forceRepelStrength actually move between
 * presets — clusters is a strong link force with low repel, sprawl a weak
 * link with high repel, and nothing about center pull or link distance
 * tells the presets apart, so both stay pinned to balanced's value in every preset
 * rather than inventing a third and fourth axis nobody asked for. */

export type ForceSettings = {
  forceCenterStrength: number
  forceRepelStrength: number
  forceLinkStrength: number
  linkDistance: number
}

/* Today's defaults, unchanged — the exact fallback values MusicMapSettings.tsx
 * and App.tsx already read when a setting has never been written. Kept here
 * as the one source of truth so "balanced = today's defaults" is
 * structural, not a claim the three copies could quietly drift apart from. */
export const BALANCED_FORCE_SETTINGS: ForceSettings = {
  forceCenterStrength: 0.03,
  forceRepelStrength: 150,
  forceLinkStrength: 0.15,
  linkDistance: 80,
}

export const MAP_PRESET_IDS = ['clusters', 'balanced', 'sprawl'] as const
export type MapPresetId = (typeof MAP_PRESET_IDS)[number]

/* Both non-balanced presets pick a point roughly a third and roughly
 * two-and-a-half times balanced's own link-force value, and repel values
 * that sit near the low and (literally, for sprawl) high end of that
 * slider's own 0-200 range — see the PR description for the fuller
 * reasoning. Never derived by formula from BALANCED_FORCE_SETTINGS: a
 * preset is a fixed, named point a person can rely on, not a moving target
 * that would quietly shift if the balanced defaults ever changed. */
export const MAP_PRESETS: Record<MapPresetId, ForceSettings> = {
  clusters: { ...BALANCED_FORCE_SETTINGS, forceLinkStrength: 0.4, forceRepelStrength: 40 },
  balanced: BALANCED_FORCE_SETTINGS,
  sprawl: { ...BALANCED_FORCE_SETTINGS, forceLinkStrength: 0.05, forceRepelStrength: 200 },
}

export const MAP_PRESET_LABELS: Record<MapPresetId, string> = {
  clusters: 'clusters',
  balanced: 'balanced',
  sprawl: 'sprawl',
}

/* Plain-language label for each force slider, technical name kept as
 * secondary text (#127's human labels). */
export const FORCE_SLIDER_LABELS: Record<keyof Omit<ForceSettings, 'linkDistance'>, { plain: string; technical: string }> = {
  forceCenterStrength: { plain: 'pull toward the middle', technical: 'center' },
  forceRepelStrength: { plain: 'space between everything', technical: 'repel' },
  forceLinkStrength: { plain: 'how tightly related music pulls together', technical: 'link force' },
}

export function forceSettingsEqual(a: ForceSettings, b: ForceSettings): boolean {
  return (
    a.forceCenterStrength === b.forceCenterStrength &&
    a.forceRepelStrength === b.forceRepelStrength &&
    a.forceLinkStrength === b.forceLinkStrength &&
    a.linkDistance === b.linkDistance
  )
}

/** Same fallback-on-missing-or-non-finite idiom MusicMapSettings.tsx's own
 * parseMultiplier already uses for every slider on this panel — a fresh
 * settings store (or one from before these keys existed) reads as balanced. */
export function forceSettingsFromSettings(settings: Settings): ForceSettings {
  const num = (raw: string | undefined, fallback: number): number => {
    const n = Number(raw)
    return raw != null && Number.isFinite(n) ? n : fallback
  }
  return {
    forceCenterStrength: num(settings.forceCenterStrength, BALANCED_FORCE_SETTINGS.forceCenterStrength),
    forceRepelStrength: num(settings.forceRepelStrength, BALANCED_FORCE_SETTINGS.forceRepelStrength),
    forceLinkStrength: num(settings.forceLinkStrength, BALANCED_FORCE_SETTINGS.forceLinkStrength),
    linkDistance: num(settings.linkDistance, BALANCED_FORCE_SETTINGS.linkDistance),
  }
}

/* The reverse direction, formatted the same way each slider's own onChange
 * already formats its value (toFixed(2) for the two 0-1 strength sliders,
 * toFixed(0) for the two sliders that step by whole units) — so applying a
 * preset writes settings indistinguishable from a person dragging every
 * slider there by hand. */
export function forceSettingsToPartialSettings(forces: ForceSettings): Settings {
  return {
    forceCenterStrength: forces.forceCenterStrength.toFixed(2),
    forceRepelStrength: forces.forceRepelStrength.toFixed(0),
    forceLinkStrength: forces.forceLinkStrength.toFixed(2),
    linkDistance: forces.linkDistance.toFixed(0),
  }
}

/** Which preset today's forces exactly match, or null once a slider has been
 * dragged off every named point — "custom", shown as no pill selected
 * rather than a fourth label nobody asked for. */
export function matchPreset(forces: ForceSettings): MapPresetId | null {
  for (const id of MAP_PRESET_IDS) {
    if (forceSettingsEqual(forces, MAP_PRESETS[id])) return id
  }
  return null
}

/* --- Session undo history (#127) ---
 *
 * A plain past/present stack over ForceSettings snapshots, not the whole
 * Settings store — undo here is scoped to exactly what this issue is about
 * (the presets/physics workflow), not a general-purpose undo for every
 * setting in the app. See MusicMapSettings.tsx / App.tsx for how this
 * plugs into the live settings store and the global Cmd/Ctrl+Z handler.
 *
 * Coalesced by time rather than recorded on every call: a slider drag fires
 * onChange continuously (one round trip per pixel of drag), and recording
 * every intermediate value would turn one drag gesture into dozens of undo
 * steps — pressing undo once would barely move the slider back. Two changes
 * within COALESCE_WINDOW_MS of each other overwrite the same checkpoint
 * instead of pushing a new one, so one undo after a drag returns to
 * wherever the slider was before that whole gesture started. */

export type ForceHistoryState = {
  past: ForceSettings[]
  present: ForceSettings
  lastChangedAt: number
}

const COALESCE_WINDOW_MS = 500
const MAX_HISTORY = 50

export function initForceHistory(present: ForceSettings): ForceHistoryState {
  // -Infinity, not 0 or "now": nothing has changed yet this session, so the
  // very first real change must never fall inside the coalesce window
  // below, however soon after init it happens.
  return { past: [], present, lastChangedAt: -Infinity }
}

/** Records a new present value, unless it's identical to the current one.
 * `now` is a plain injected timestamp (Date.now() from the real hook,
 * deterministic numbers in tests) rather than this module reading the
 * clock itself, so the coalescing window is exercised without real timers. */
export function recordForceChange(state: ForceHistoryState, next: ForceSettings, now: number): ForceHistoryState {
  if (forceSettingsEqual(state.present, next)) return state
  const withinCoalesceWindow = now - state.lastChangedAt < COALESCE_WINDOW_MS
  const past = withinCoalesceWindow ? state.past : [...state.past, state.present]
  return { past: past.length > MAX_HISTORY ? past.slice(past.length - MAX_HISTORY) : past, present: next, lastChangedAt: now }
}

/** Pops the most recent checkpoint back into `present`. A no-op (returns the
 * same object) with nothing to undo, so callers can compare by reference to
 * decide whether anything actually changed. */
export function undoForceChange(state: ForceHistoryState, now: number): ForceHistoryState {
  if (state.past.length === 0) return state
  const present = state.past[state.past.length - 1]
  return { past: state.past.slice(0, -1), present, lastChangedAt: now }
}

export function canUndoForceChange(state: ForceHistoryState): boolean {
  return state.past.length > 0
}
