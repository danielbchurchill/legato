import { useEffect } from 'react'
import { useToast } from '../ui/toastContext'

/* The install prompt (#128). Chrome fires `beforeinstallprompt` as soon as
 * the page qualifies, usually on load, and shows its own banner unless the
 * page claims the event. The plan wants the offer at a natural moment
 * instead, "after first successful playback, never on page load". So the
 * event is claimed and held from startup (main.tsx), and the offer only
 * appears once a track has actually started playing.
 *
 * Offered once per device. Someone who dismissed it has answered, and the
 * browser's own "Install app" menu item is still there if they change their
 * mind. */

/** Chrome's event; not in the DOM lib because it was never standardized. */
export type InstallPromptEvent = Event & { prompt(): Promise<unknown> }

const OFFERED_KEY = 'legato:install-offered'

export type InstallOffer = {
  /** The held event, ready to show, or null if there's nothing to offer. */
  ready(): InstallPromptEvent | null
  /** Records that the offer was shown, so it isn't again. */
  markOffered(): void
  subscribe(listener: () => void): () => void
  captured(event: InstallPromptEvent): void
  installed(): void
  playbackStarted(): void
}

export function createInstallOffer(storage: Storage | null): InstallOffer {
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
    ready: () => (held && played && !offered() ? held : null),
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

const offer = createInstallOffer(typeof localStorage === 'undefined' ? null : localStorage)

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
      const event = offer.ready()
      if (!event) return
      offer.markOffered()
      toast.show({
        title: 'install legato',
        description: 'open it from your home screen, with lock-screen controls.',
        action: { label: 'install', onClick: () => void event.prompt().catch(() => undefined) },
        duration: null,
      })
    }
    showIfReady()
    return offer.subscribe(showIfReady)
  }, [toast])
}
