import { useEffect } from 'react'
import { useToast } from '../ui/toastContext'
import { HTTPS_DOCS_URL, NEEDS_HTTPS } from './register'

/* The install prompt (#128). Chrome fires `beforeinstallprompt` as soon as
 * the page qualifies, usually on load, and shows its own banner unless the
 * page claims the event. The offer belongs at a natural moment instead:
 * after the first successful playback, never on page load. So the
 * event is claimed and held from startup (main.tsx), and the offer only
 * appears once a track has actually started playing.
 *
 * Offered once per device. Someone who dismissed it has answered, and the
 * browser's own "Install app" menu item is still there if they change their
 * mind.
 *
 * Over plain http, off localhost, Chrome never fires the event: no secure
 * context, no worker, no install (register.ts, needsHttps). The same moment
 * says why instead, once, and links the page on serving Legato over https
 * (#316). */

/** Chrome's event; not in the DOM lib because it was never standardized. */
export type InstallPromptEvent = Event & { prompt(): Promise<unknown> }

const OFFERED_KEY = 'legato:install-offered'

/** What to show: the held event, or why this page can't be installed. */
export type Offer = { kind: 'install'; event: InstallPromptEvent } | { kind: 'needs-https' }

export type InstallOffer = {
  /** What's ready to show, or null if there's nothing to offer yet. */
  ready(): Offer | null
  /** Records that the offer was shown, so it isn't again. */
  markOffered(): void
  subscribe(listener: () => void): () => void
  captured(event: InstallPromptEvent): void
  installed(): void
  playbackStarted(): void
}

export function createInstallOffer(storage: Storage | null, needsHttps = false): InstallOffer {
  let held: InstallPromptEvent | null = null
  let played = false
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach((listener) => listener())

  const offered = () => {
    try {
      return storage?.getItem(OFFERED_KEY) === 'true'
    } catch {
      return false
    }
  }

  const markOffered = () => {
    try {
      storage?.setItem(OFFERED_KEY, 'true')
    } catch {
      // Storage unavailable: the offer just might come back next session.
    }
  }

  return {
    ready() {
      if (!played || offered()) return null
      if (held) return { kind: 'install', event: held }
      return needsHttps ? { kind: 'needs-https' } : null
    },
    markOffered,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    captured(event) {
      held = event
      notify()
    },
    installed() {
      held = null
      markOffered()
    },
    playbackStarted() {
      if (played) return
      played = true
      notify()
    },
  }
}

const offer = createInstallOffer(typeof localStorage === 'undefined' ? null : localStorage, NEEDS_HTTPS)

/** Claims Chrome's install event before its banner can show. Called once,
 * from main.tsx, before the first render. */
export function holdInstallPrompt(): void {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault()
    offer.captured(event as InstallPromptEvent)
  })
  window.addEventListener('appinstalled', () => offer.installed())
}

/** Called by usePlayback when the web player's <audio> first reports
 * `playing`: sound is actually coming out, not just a click on play. */
export function notePlaybackStarted(): void {
  offer.playbackStarted()
}

/** Shows the offer as a toast the first time it's ready. Mounted once, in
 * MainApp. The browser only accepts prompt() from a user gesture, which is
 * why it's an action the user presses rather than a dialog opened here. */
export function useInstallOffer(): void {
  const toast = useToast()
  useEffect(() => {
    const showIfReady = () => {
      const ready = offer.ready()
      if (!ready) return
      offer.markOffered()
      toast.show(
        ready.kind === 'install'
          ? {
              title: 'install legato',
              description: 'open it from your home screen, with lock-screen controls.',
              action: { label: 'install', onClick: () => void ready.event.prompt().catch(() => undefined) },
              duration: null,
            }
          : {
              title: "can't install legato over http",
              description: 'browsers only install web apps from an https address.',
              action: { label: 'how to serve it over https', onClick: () => void window.open(HTTPS_DOCS_URL, '_blank', 'noreferrer') },
              duration: null,
            },
      )
    }
    showIfReady()
    return offer.subscribe(showIfReady)
  }, [toast])
}
