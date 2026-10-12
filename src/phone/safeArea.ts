import { useSyncExternalStore } from 'react'

/* The safe-area insets as numbers, for the sheet's arithmetic. CSS reads
 * them as env(safe-area-inset-*), which needs viewport-fit=cover (index.html)
 * to be anything but 0; the sheet's detents need them in px. They come from
 * the platform, never a hardcoded status bar: the handoff's 54/34 and 40/24
 * are what they are on its two frames. */

export type SafeArea = { top: number; bottom: number }

const NONE: SafeArea = { top: 0, bottom: 0 }
let probe: HTMLDivElement | null = null
let cached: SafeArea = NONE

function read(): SafeArea {
  if (typeof document === 'undefined' || !document.body) return NONE
  if (!probe) {
    probe = document.createElement('div')
    probe.setAttribute('aria-hidden', 'true')
    probe.style.cssText =
      'position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
      'padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)'
    document.body.appendChild(probe)
  }
  const style = getComputedStyle(probe)
  const top = parseFloat(style.paddingTop) || 0
  const bottom = parseFloat(style.paddingBottom) || 0
  if (top !== cached.top || bottom !== cached.bottom) cached = { top, bottom }
  return cached
}

function subscribe(onChange: () => void): () => void {
  // Turning the phone changes them, and a resize comes with it.
  window.addEventListener('resize', onChange)
  return () => window.removeEventListener('resize', onChange)
}

export function useSafeArea(): SafeArea {
  return useSyncExternalStore(subscribe, read, () => NONE)
}
