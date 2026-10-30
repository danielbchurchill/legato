import { createContext, useContext, useSyncExternalStore } from 'react'
import { SERVER_ORIGIN } from '../config/serverHost'
import type { AvailableUpdate } from '../hooks/useServerReady'

/* A newer legato-server release (#110), offered by the server's own daily
 * check, and which server it's for (#405). App.tsx provides it from the
 * heartbeat (UpdateOfferProvider, ServerUpdateNotice.tsx); the desktop's
 * pill under the capsule and the phone's Settings row read it. "Legato
 * 0.1.0 is available" read on a phone as the phone's own update, so the
 * words name the server. Either place dismisses a release on this device
 * until the server offers a newer one. */

export type UpdateOffer = AvailableUpdate & {
  /** What the server calls itself (/health's name), or null from one too
   * old to say. */
  serverName: string | null
}

export const UpdateOfferContext = createContext<UpdateOffer | null>(null)

// The release this device dismissed, per server origin, as lastSeen.ts
// keys what it remembers. A newer release is a different version, so it
// shows again. Where storage is blocked, it's kept for this page instead.
const STORAGE_KEY = 'legato:update-dismissed'
const listeners = new Set<() => void>()
const dismissedThisPage: Record<string, string> = {}

function readDismissed(): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

function dismissedHere(): string | null {
  return readDismissed()[SERVER_ORIGIN] ?? dismissedThisPage[SERVER_ORIGIN] ?? null
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function dismissUpdate(version: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readDismissed(), [SERVER_ORIGIN]: version }))
  } catch {
    dismissedThisPage[SERVER_ORIGIN] = version
  }
  listeners.forEach((listener) => listener())
}

/** The offer, unless this device dismissed its release. */
export function useUpdateOffer(): UpdateOffer | null {
  const offer = useContext(UpdateOfferContext)
  const dismissed = useSyncExternalStore(subscribe, dismissedHere)
  return offer && offer.latestVersion !== dismissed ? offer : null
}
