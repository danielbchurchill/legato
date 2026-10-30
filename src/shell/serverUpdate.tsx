import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { RELAY_SERVER_ID, SERVED_SERVER_ID, SERVER_HOST, SERVER_ORIGIN } from '../config/serverHost'
import type { AvailableUpdate, ServerVersion } from '../hooks/useServerReady'

/* A newer legato-server release (#110), offered by the server's own daily
 * check, and which server it's for (#405). App.tsx provides it from the
 * heartbeat; the desktop's pill (ServerUpdateNotice.tsx) and the phone's
 * Settings row read it. "Legato 0.1.0 is available" read on a phone as the
 * phone's own update, so the words name the server. Either place dismisses
 * a release on this device until the server offers a newer one. */

export type UpdateOffer = AvailableUpdate & {
  /** What the server calls itself (/health's name), or null from one too
   * old to say. */
  serverName: string | null
}

const UpdateOfferContext = createContext<UpdateOffer | null>(null)

export function UpdateOfferProvider({ server, name, children }: { server: ServerVersion | null; name: string | null; children: ReactNode }) {
  // Out of date wins: that notice says to update the server, and why.
  const update = server && !server.outOfDate ? server.update : null
  const offer = useMemo(() => (update ? { ...update, serverName: name } : null), [update, name])
  return <UpdateOfferContext.Provider value={offer}>{children}</UpdateOfferContext.Provider>
}

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

/** "legato-server 0.1.0 is available for raspberrypi". A server that gave
 * no name goes by its short id, as the account's server list names one, or
 * by its address where this page doesn't know the id. */
export function UpdateWording({ offer }: { offer: UpdateOffer }) {
  const id = SERVED_SERVER_ID ?? RELAY_SERVER_ID
  return (
    <>
      legato-server {offer.latestVersion} is available for{' '}
      {offer.serverName ?? <span className="mono">{id ? `${id.slice(0, 8)}…` : SERVER_HOST}</span>}
    </>
  )
}
