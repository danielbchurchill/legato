import { useEffect, useState, useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { IS_TAURI } from '../config/runtime'

/* The desktop app's own update (#129). src-tauri/src/updater.rs checks at
 * launch and at most once a day, downloads a newer release in the
 * background, and says so here once it's ready. The pill under the capsule
 * shows it (DesktopUpdatePill.tsx). Nothing installs until someone asks:
 * restarting stops the server any phones are playing from. */

/** updater.rs's Notice. */
export type DesktopUpdate = {
  version: string
  action: { kind: 'restart' } | { kind: 'link'; url: string }
}

const READY_EVENT = 'desktop-update://ready'

// The release this device dismissed. A newer release is a different version,
// so it shows again. Where storage is blocked, it's kept for this page.
const STORAGE_KEY = 'legato:desktop-update-dismissed'
const listeners = new Set<() => void>()
let dismissedThisPage: string | null = null

function dismissedHere(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? dismissedThisPage
  } catch {
    return dismissedThisPage
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function dismissDesktopUpdate(version: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, version)
  } catch {
    dismissedThisPage = version
  }
  listeners.forEach((listener) => listener())
}

/** The update that's ready, unless this device dismissed its release. Null
 * outside the desktop app. */
export function useDesktopUpdate(): DesktopUpdate | null {
  const [update, setUpdate] = useState<DesktopUpdate | null>(null)
  const dismissed = useSyncExternalStore(subscribe, dismissedHere)

  useEffect(() => {
    if (!IS_TAURI) return
    let live = true
    // Asked once for one found before this page loaded, then told about
    // the next.
    invoke<DesktopUpdate | null>('desktop_update')
      .then((ready) => {
        if (live && ready) setUpdate(ready)
      })
      .catch(() => undefined)
    const unlisten = listen<DesktopUpdate>(READY_EVENT, (event) => setUpdate(event.payload))
    return () => {
      live = false
      void unlisten.then((stop) => stop())
    }
  }, [])

  return update && update.version !== dismissed ? update : null
}

/** Installs the ready update and restarts into it. Rejects when it couldn't
 * install, and then the server is serving again. */
export function restartToUpdate(): Promise<void> {
  return invoke('desktop_update_restart')
}

/** The release page, for an update that didn't install. */
export function releasePage(version: string): string {
  return `https://github.com/danielbchurchill/legato/releases/tag/v${version}`
}
