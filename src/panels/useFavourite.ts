import { useState } from 'react'
import { API } from './useNodeDetail'

/* The heart, optimistically: it flips the instant it's clicked rather than
 * after the POST/DELETE (DESIGN.md "Acknowledge under 100ms"), and rolls
 * back if the request fails. Resyncs from server truth whenever a fresh
 * node arrives — a new selection, or useNodeDetail's favourites:changed
 * listener correcting a write that failed quietly. Resynced during render,
 * not in an effect, so a new node never paints one frame of the last one's
 * heart. */
export function useFavourite(nodeId: number, serverValue: boolean): [boolean, () => void] {
  const [isFavourite, setIsFavourite] = useState(serverValue)
  const [syncedFrom, setSyncedFrom] = useState({ nodeId, serverValue })
  if (syncedFrom.nodeId !== nodeId || syncedFrom.serverValue !== serverValue) {
    setSyncedFrom({ nodeId, serverValue })
    setIsFavourite(serverValue)
  }

  const toggle = () => {
    const next = !isFavourite
    setIsFavourite(next)
    fetch(`${API}/favourites/${nodeId}`, { method: next ? 'POST' : 'DELETE' }).catch(() => setIsFavourite(!next))
  }

  return [isFavourite, toggle]
}
