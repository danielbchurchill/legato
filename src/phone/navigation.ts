import { useSyncExternalStore } from 'react'
import type { WorklistKind } from '../shell/panels'

/* Where the phone is (#389): the pushed pages, full-screen over the map,
 * such as Settings and Library health, each with the platform's own back,
 * and Now playing, with its collapse chevron for one; the overlays the
 * sheet shows in place of its tabs, search and node detail; and a view
 * open in its collections tab (below).
 *
 * All three live in the browser's history, so Android's back gesture, the
 * browser's back button and the app's own back all go back the same way:
 * opening a page or an overlay adds a history entry carrying where the phone
 * now is, and going back to an entry restores what it carries. Forward
 * works the same way, and a reload keeps what was showing, so the history
 * and what's on screen never disagree. The URL never changes; the entries
 * only carry state. */

/* Library health's lists each push as a page of their own. */
export type PhonePage = 'settings' | 'health' | `worklist:${WorklistKind}` | 'now-playing'

/** What the sheet shows over its tabs: search, or a node's detail. */
export type SheetOverlay = { kind: 'search' } | { kind: 'node'; id: number }

const WORKLISTS: readonly WorklistKind[] = ['duplicates', 'missing', 'enrichment', 'tag-writes', 'gaps']
const PAGES: readonly PhonePage[] = ['settings', 'health', ...WORKLISTS.map((list) => `worklist:${list}` as const), 'now-playing']

/** The list a worklist page shows; null for any other page. */
export function worklistOf(page: PhonePage): WorklistKind | null {
  return WORKLISTS.find((list) => page === `worklist:${list}`) ?? null
}

/* Where each sits in history.state, beside anything else's state. */
const PAGES_KEY = 'legatoPhonePages'
const OVERLAYS_KEY = 'legatoSheetOverlays'

type Place = { pages: readonly PhonePage[]; overlays: readonly SheetOverlay[] }

const NOWHERE: Place = { pages: [], overlays: [] }

function entry(state: unknown, key: string): unknown[] {
  const value = state != null && typeof state === 'object' ? (state as Record<string, unknown>)[key] : null
  return Array.isArray(value) ? value : []
}

function isOverlay(value: unknown): value is SheetOverlay {
  if (value == null || typeof value !== 'object') return false
  const overlay = value as Record<string, unknown>
  return overlay.kind === 'search' || (overlay.kind === 'node' && typeof overlay.id === 'number')
}

/* A view opened inside the sheet, which back leaves the way it pops a page:
 * Favourites, a playlist or the import form, opened from the collections tab
 * (#389, step 3). It rides in the same history entries as the pages, under
 * its own key, so a page pushed over a view comes back to it. There's one
 * at most: opening another replaces it, so back always lands on the tab
 * itself. */

export type SheetView = { kind: 'favourites' } | { kind: 'playlist'; playlistId: number } | { kind: 'import' }

const VIEW_KEY = 'legatoSheetView'

function viewIn(state: unknown): SheetView | null {
  const value = state != null && typeof state === 'object' ? (state as Record<string, unknown>)[VIEW_KEY] : null
  if (value == null || typeof value !== 'object') return null
  const candidate = value as { kind?: unknown; playlistId?: unknown }
  if (candidate.kind === 'favourites' || candidate.kind === 'import') return { kind: candidate.kind }
  if (candidate.kind === 'playlist' && typeof candidate.playlistId === 'number') {
    return { kind: 'playlist', playlistId: candidate.playlistId }
  }
  return null
}

function placeIn(state: unknown): Place {
  return {
    pages: entry(state, PAGES_KEY).filter((page): page is PhonePage => PAGES.includes(page as PhonePage)),
    overlays: entry(state, OVERLAYS_KEY).filter(isOverlay),
  }
}

let place: Place = typeof history === 'undefined' ? NOWHERE : placeIn(history.state)
let view: SheetView | null = typeof history === 'undefined' ? null : viewIn(history.state)
const listeners = new Set<() => void>()

function setPlace(next: Place) {
  place = next
  for (const listener of listeners) listener()
}

function onPopState(event: PopStateEvent) {
  view = viewIn(event.state)
  setPlace(placeIn(event.state))
}

/* Goes somewhere new: a new history entry, or this one rewritten. */
function go(next: Place, replace = false) {
  const state: unknown = history.state
  const merged = { ...(state != null && typeof state === 'object' ? state : {}), [PAGES_KEY]: next.pages, [OVERLAYS_KEY]: next.overlays }
  if (replace) history.replaceState(merged, '')
  else history.pushState(merged, '')
  setPlace(next)
}

/** Opens a page over whatever is showing. The page already on top isn't
 * pushed again, so a double tap doesn't need two backs. */
export function pushPhonePage(page: PhonePage) {
  if (place.pages[place.pages.length - 1] === page) return
  go({ ...place, pages: [...place.pages, page] })
}

/** Closes the top page, as the system's back would. Nothing to close does
 * nothing, rather than leaving the app. */
export function popPhonePage() {
  if (place.pages.length === 0) return
  history.back()
}

/** Closes the top page, then runs `then` once the history is back where it
 * was. Something that goes somewhere new as a page closes, such as Now
 * playing's go to album opening the album's detail, has to wait: a back is
 * answered later, so an entry pushed straight away would be the one it
 * leaves. With no page open, `then` runs now. */
export function popPhonePageThen(then: () => void) {
  if (place.pages.length === 0) return then()
  // After onPopState, which subscribe added first, so `place` is current.
  window.addEventListener('popstate', () => then(), { once: true })
  history.back()
}

/** Closes every page, back to the map, as that many backs would: something
 * opened on the map from a page shows the map. */
export function closePhonePages() {
  if (place.pages.length === 0) return
  history.go(-place.pages.length)
}

function sameOverlay(a: SheetOverlay | undefined, b: SheetOverlay): boolean {
  return a != null && a.kind === b.kind && (a.kind === 'search' || (b.kind === 'node' && a.id === b.id))
}

/** Shows an overlay in the sheet, over whatever it shows now; back returns
 * there. The overlay already showing isn't pushed again. */
export function pushSheetOverlay(overlay: SheetOverlay) {
  if (sameOverlay(place.overlays[place.overlays.length - 1], overlay)) return
  go({ ...place, overlays: [...place.overlays, overlay] })
}

/** Shows an overlay in place of the one showing, so back skips it. */
export function replaceSheetOverlay(overlay: SheetOverlay) {
  if (place.overlays.length === 0) return pushSheetOverlay(overlay)
  if (sameOverlay(place.overlays[place.overlays.length - 1], overlay)) return
  go({ ...place, overlays: [...place.overlays.slice(0, -1), overlay] }, true)
}

/** Goes back one overlay, as the system's back would. Nothing to close does
 * nothing, rather than leaving the app. */
export function popSheetOverlay() {
  if (place.overlays.length === 0) return
  history.back()
}

/** Where the phone is now, read outside React. */
export function currentSheetOverlays(): readonly SheetOverlay[] {
  return place.overlays
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    window.addEventListener('popstate', onPopState)
    // Nothing listened while no phone shell was mounted.
    place = placeIn(history.state)
    view = viewIn(history.state)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) window.removeEventListener('popstate', onPopState)
  }
}

/** The pushed pages, bottom first. Empty is the map. */
export function usePhonePages(): readonly PhonePage[] {
  return useSyncExternalStore(subscribe, () => place.pages)
}

/** The sheet's overlays, bottom first. Empty is the sheet's own tabs. */
export function useSheetOverlays(): readonly SheetOverlay[] {
  return useSyncExternalStore(subscribe, () => place.overlays)
}

/** Opens a view in the sheet, in place of any already open. */
export function openSheetView(next: SheetView) {
  const state: unknown = history.state
  const entry = { ...(state != null && typeof state === 'object' ? state : {}), [VIEW_KEY]: next }
  if (view == null) history.pushState(entry, '')
  else history.replaceState(entry, '')
  view = next
  for (const listener of listeners) listener()
}

/** Leaves the open view, as the system's back would. */
export function closeSheetView() {
  if (view == null) return
  history.back()
}

/** Leaves the sheet's overlays for a view, in one step: the history entry
 * showing them shows the view instead, so back from the view goes where
 * back from the top overlay would have. A playlist opened from search. */
export function replaceOverlaysWithView(next: SheetView) {
  const state: unknown = history.state
  history.replaceState({ ...(state != null && typeof state === 'object' ? state : {}), [OVERLAYS_KEY]: [], [VIEW_KEY]: next }, '')
  view = next
  setPlace({ ...place, overlays: [] })
}

/** The view open in the sheet, if any. */
export function useSheetView(): SheetView | null {
  return useSyncExternalStore(subscribe, () => view)
}
