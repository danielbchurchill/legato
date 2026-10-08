import { useSyncExternalStore } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { IS_TAURI } from '../config/runtime'

/* Per-device dark / light / follow-system (#136) — deliberately NOT
 * routed through useSettings.ts's server-backed store. It's stored per
 * device, not per account, since a work laptop and a phone can differ.
 * localStorage, not the settings API. */

export type ThemePreference = 'dark' | 'light' | 'system'
export type ResolvedTheme = 'dark' | 'light'

const STORAGE_KEY = 'legato:theme'

// #282: a first launch starts in ink. Following the system is a choice in
// Settings, not the default.
const FIRST_LAUNCH: ThemePreference = 'dark'

function isThemePreference(value: string | null): value is ThemePreference {
  return value === 'dark' || value === 'light' || value === 'system'
}

function readStoredPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return isThemePreference(stored) ? stored : FIRST_LAUNCH
  } catch {
    // Storage unavailable (private browsing, disabled entirely) — start in
    // ink, same as a first launch would.
    return FIRST_LAUNCH
  }
}

function systemPrefersLight(): boolean {
  return window.matchMedia('(prefers-color-scheme: light)').matches
}

function resolveTheme(preference: ThemePreference, systemLight: boolean): ResolvedTheme {
  return preference === 'system' ? (systemLight ? 'light' : 'dark') : preference
}

// index.html's inline boot script sets this same attribute, synchronously,
// before first paint — see its own comment for why. This is what keeps it
// live afterward: every change of the resolved theme goes through here, one
// place, so nothing in the component tree ever branches on theme itself.
function applyTheme(theme: ResolvedTheme): void {
  document.documentElement.dataset.theme = theme
  // #128: the browser's own chrome (an installed app's title bar, Android's
  // status bar) follows the canvas colour. Read back from the token rather
  // than repeated as a hex, so tokens.css stays the one place it's defined.
  const canvas = getComputedStyle(document.documentElement).getPropertyValue('--color-canvas').trim()
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (meta && canvas) meta.content = canvas
}

/* #282: one theme for the whole page, kept here rather than in component
 * state. data-theme moves the moment the theme changes, before React
 * re-renders anything, so whatever reads the tokens on a theme change (the
 * map re-resolving its palette, in an effect below MainApp's) already sees
 * the new ones. An effect couldn't promise that: React runs a child's effects
 * before its parent's. And every useTheme() is a view of this one store, so
 * no component holds a copy of the preference that could go stale and
 * re-apply an old theme. */
type ThemeState = { preference: ThemePreference; systemLight: boolean }

let state: ThemeState | null = null
const listeners = new Set<() => void>()
let stopWatchingSystem: (() => void) | null = null

function getState(): ThemeState {
  state ??= { preference: readStoredPreference(), systemLight: systemPrefersLight() }
  return state
}

function update(next: Partial<ThemeState>): void {
  const current = getState()
  const updated = { ...current, ...next }
  if (updated.preference === current.preference && updated.systemLight === current.systemLight) return
  state = updated
  applyTheme(resolveTheme(updated.preference, updated.systemLight))
  for (const listener of listeners) listener()
}

// Only consulted while preference === 'system' (see resolveTheme), but
// tracked whenever anything is mounted — switching *into* 'system' must not
// show a stale answer from whenever this last updated.
function watchSystemTheme(onChange: (light: boolean) => void): () => void {
  // Tauri: the window theme API with its theme-changed event.
  // Distinct from prefers-color-scheme by design — this is the window's own
  // theme, which stays correct if the OS setting changes while the window is
  // unfocused or minimized, which a webview-internal media query is not
  // guaranteed to do the same way across every platform Tauri targets.
  if (IS_TAURI) {
    let cancelled = false
    const win = getCurrentWindow()

    win
      .theme()
      .then((theme) => {
        if (!cancelled && theme) onChange(theme === 'light')
      })
      .catch(() => undefined)

    const unlisten = win.onThemeChanged(({ payload }) => onChange(payload === 'light')).catch(() => undefined)

    return () => {
      cancelled = true
      unlisten.then((f) => f?.())
    }
  }

  // Web: prefers-color-scheme, tracked live via the standard media query
  // change event, which is what follow-system means on the web. Read once on
  // subscribing too, in case it moved between the first render and now.
  const mql = window.matchMedia('(prefers-color-scheme: light)')
  const read = () => onChange(mql.matches)
  mql.addEventListener('change', read)
  read()
  return () => mql.removeEventListener('change', read)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) {
    const { preference, systemLight } = getState()
    applyTheme(resolveTheme(preference, systemLight))
    stopWatchingSystem = watchSystemTheme((light) => update({ systemLight: light }))
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      stopWatchingSystem?.()
      stopWatchingSystem = null
    }
  }
}

function setPreference(next: ThemePreference): void {
  update({ preference: next })
  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // Same storage-unavailable case as readStoredPreference — the choice
    // just doesn't survive a reload; it still applies for this session.
  }
}

export function useTheme(): {
  preference: ThemePreference
  resolvedTheme: ResolvedTheme
  setPreference: (preference: ThemePreference) => void
} {
  const { preference, systemLight } = useSyncExternalStore(subscribe, getState)
  return { preference, resolvedTheme: resolveTheme(preference, systemLight), setPreference }
}
