import { useSyncExternalStore } from 'react'
import { INSET, computeShellLayout, type ShellLayout } from '../shell/layout'

/* The phone layout (#389): Claude Design's "Legato Mobile v2", the web
 * client at phone widths. The map is the ground and everything else lives in
 * one bottom sheet. It applies at this width or narrower. The desktop app's
 * narrowest window is 1100px, so it never sees it; a browser narrowed past
 * it does, which is how the layout is checked without a phone. */
export const PHONE_MAX_WIDTH = 600

const QUERY = `(max-width: ${PHONE_MAX_WIDTH}px)`

function subscribe(onChange: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => {}
  const mql = window.matchMedia(QUERY)
  mql.addEventListener('change', onChange)
  return () => mql.removeEventListener('change', onChange)
}

function isPhoneWidth(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(QUERY).matches
}

/** True while the viewport is phone-width. A phone turned to landscape is
 * wider than this and gets the desktop shell: landscape isn't designed. */
export function usePhoneLayout(): boolean {
  return useSyncExternalStore(subscribe, isPhoneWidth, () => false)
}

export type PhonePlatform = 'ios' | 'android'

/* One design for both platforms; only system chrome differs, such as the
 * top bar on a pushed page. Android says so in its user agent. Everything
 * else gets iOS, the handoff's first frame, including a desktop browser
 * narrowed to phone width. */
export function phonePlatform(userAgent: string = navigator.userAgent): PhonePlatform {
  return /android/i.test(userAgent) ? 'android' : 'ios'
}

/* The shell geometry the map's camera, its card, the search palette and the
 * library read (shell/layout.ts), for the phone. Nothing occupies either
 * side, the palette spans the screen less the inset, and the map keeps what
 * it fits between the controls floating over its top (mapTop) and the sheet
 * at peek. */
export function phoneShellLayout(width: number, height: number, sheetPeek: number, mapTop: number): ShellLayout {
  const desktop = computeShellLayout(width, height, { leftOpen: false, rightOpen: false })
  return {
    ...desktop,
    leftOccupancy: 0,
    rightOccupancy: 0,
    free: width,
    cx: width / 2,
    paletteWidth: width - 2 * INSET,
    paletteCx: width / 2,
    floatingBottom: sheetPeek,
    mapTop,
  }
}
