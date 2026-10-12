import { useSyncExternalStore } from 'react'

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

export type PhonePage = 'settings' | 'health'

const PAGES: readonly PhonePage[] = ['settings', 'health']

/* Where the stack sits in history.state, beside anything else's state. */
const STATE_KEY = 'legatoPhonePages'

function pagesIn(state: unknown): readonly PhonePage[] {
  const pages = state != null && typeof state === 'object' ? (state as Record<string, unknown>)[STATE_KEY] : null
  return Array.isArray(pages) ? pages.filter((page): page is PhonePage => PAGES.includes(page)) : []
}

let pages: readonly PhonePage[] = typeof history === 'undefined' ? [] : pagesIn(history.state)
const listeners = new Set<() => void>()

function setPages(next: readonly PhonePage[]) {
  pages = next
  for (const listener of listeners) listener()
}

function onPopState(event: PopStateEvent) {
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

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    window.addEventListener('popstate', onPopState)
    // Nothing listened while no phone shell was mounted.
    pages = pagesIn(history.state)
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
