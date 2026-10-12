import { useSyncExternalStore } from 'react'
import type { WorklistKind } from '../shell/panels'

/* Pushed pages on the phone (#389): full-screen pages over the map, such as
 * Settings and Library health, each with the platform's own back.
 *
 * The stack lives in the browser's history, so Android's back gesture, the
 * browser's back button and the page's own back all pop it the same way:
 * pushing a page adds a history entry carrying the whole stack, and going
 * back to an entry restores the stack it carries. Forward works the same
 * way, and a reload keeps the page that was showing, so the history and
 * what's on screen never disagree. The URL never changes; the entries only
 * carry state. */

/* Library health's lists each push as a page of their own. */
export type PhonePage = 'settings' | 'health' | `worklist:${WorklistKind}`

const WORKLISTS: readonly WorklistKind[] = ['duplicates', 'missing', 'enrichment', 'tag-writes', 'gaps']
const PAGES: readonly PhonePage[] = ['settings', 'health', ...WORKLISTS.map((list) => `worklist:${list}` as const)]

/** The list a worklist page shows; null for any other page. */
export function worklistOf(page: PhonePage): WorklistKind | null {
  return WORKLISTS.find((list) => page === `worklist:${list}`) ?? null
}

/* Where the stack sits in history.state, beside anything else's state. */
const STATE_KEY = 'legatoPhonePages'

function pagesIn(state: unknown): readonly PhonePage[] {
  const pages = state != null && typeof state === 'object' ? (state as Record<string, unknown>)[STATE_KEY] : null
  return Array.isArray(pages) ? pages.filter((page): page is PhonePage => PAGES.includes(page)) : []
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

let pages: readonly PhonePage[] = typeof history === 'undefined' ? [] : pagesIn(history.state)
let view: SheetView | null = typeof history === 'undefined' ? null : viewIn(history.state)
const listeners = new Set<() => void>()

function setPages(next: readonly PhonePage[]) {
  pages = next
  for (const listener of listeners) listener()
}

function onPopState(event: PopStateEvent) {
  view = viewIn(event.state)
  setPages(pagesIn(event.state))
}

/** Opens a page over whatever is showing. The page already on top isn't
 * pushed again, so a double tap doesn't need two backs. */
export function pushPhonePage(page: PhonePage) {
  if (pages[pages.length - 1] === page) return
  const next = [...pages, page]
  const state: unknown = history.state
  history.pushState({ ...(state != null && typeof state === 'object' ? state : {}), [STATE_KEY]: next }, '')
  setPages(next)
}

/** Closes the top page, as the system's back would. Nothing to close does
 * nothing, rather than leaving the app. */
export function popPhonePage() {
  if (pages.length === 0) return
  history.back()
}

/** Closes every page, back to the map, as that many backs would: something
 * opened on the map from a page shows the map. */
export function closePhonePages() {
  if (pages.length === 0) return
  history.go(-pages.length)
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    window.addEventListener('popstate', onPopState)
    // Nothing listened while no phone shell was mounted.
    pages = pagesIn(history.state)
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
  return useSyncExternalStore(subscribe, () => pages)
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

/** The view open in the sheet, if any. */
export function useSheetView(): SheetView | null {
  return useSyncExternalStore(subscribe, () => view)
}
