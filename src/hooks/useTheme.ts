import { useCallback, useEffect, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { IS_TAURI } from '../config/runtime'

/* Per-device dark / light / follow-system (#136) — deliberately NOT
 * routed through useSettings.ts's server-backed store. It's stored per
 * device, not per account, since a work laptop and a phone can differ.
 * localStorage, not the settings API. */

export type ThemePreference = 'dark' | 'light' | 'system'
export type ResolvedTheme = 'dark' | 'light'

const STORAGE_KEY = 'legato:theme'

function isThemePreference(value: string | null): value is ThemePreference {
  return value === 'dark' || value === 'light' || value === 'system'
}

function readStoredPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return isThemePreference(stored) ? stored : 'system'
  } catch {
    // Storage unavailable (private browsing, disabled entirely) — fall back
    // to following the system, same as a first launch would.
    return 'system'
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
// live afterward: every render of the resolved theme goes through here, one
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

export function useTheme(): {
  preference: ThemePreference
  resolvedTheme: ResolvedTheme
  setPreference: (preference: ThemePreference) => void
} {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => readStoredPreference())
  // Only consulted while preference === 'system' (see resolveTheme), but
  // tracked unconditionally — switching *into* 'system' must not show a
  // stale answer from whenever this last updated.
  const [systemLight, setSystemLight] = useState<boolean>(() => systemPrefersLight())

  const resolvedTheme = resolveTheme(preference, systemLight)

  useEffect(() => {
    applyTheme(resolvedTheme)
  }, [resolvedTheme])

  // Web: prefers-color-scheme, tracked live via the standard media query
  // change event, which is what follow-system means on the web. Skipped
  // entirely inside Tauri: that shell gets its own effect below, rather
  // than both racing to set the same state.
  useEffect(() => {
    if (IS_TAURI) return
    const mql = window.matchMedia('(prefers-color-scheme: light)')
    const onChange = () => setSystemLight(mql.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  // Tauri: the window theme API with its theme-changed event.
  // Distinct from prefers-color-scheme by design — this is the window's own
  // theme, which stays correct if the OS setting changes while the window is
  // unfocused or minimized, which a webview-internal media query is not
  // guaranteed to do the same way across every platform Tauri targets.
  useEffect(() => {
    if (!IS_TAURI) return
    let cancelled = false
    const win = getCurrentWindow()

    win
      .theme()
      .then((theme) => {
        if (!cancelled && theme) setSystemLight(theme === 'light')
      })
      .catch(() => undefined)

    const unlisten = win.onThemeChanged(({ payload }) => setSystemLight(payload === 'light')).catch(() => undefined)

    return () => {
      cancelled = true
      unlisten.then((f) => f?.())
    }
  }, [])

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Same storage-unavailable case as readStoredPreference — the choice
      // just doesn't survive a reload; it still applies for this session.
    }
  }, [])

  return { preference, resolvedTheme, setPreference }
}
