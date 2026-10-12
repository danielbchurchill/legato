import { useState } from 'react'
import type { DetailsTab } from '../shell/panels'
import type { usePlayback } from '../playback/usePlayback'
import { useNodeDetails, type NodeDetailsData } from '../panels/nodeDetailsData'
import { currentSheetOverlays, popSheetOverlay, pushSheetOverlay, replaceSheetOverlay } from './navigation'

type Playback = ReturnType<typeof usePlayback>

/* The one way into a node's detail on the phone (#389, Legato Mobile v2
 * screen 5): a tap on the map, a search result, a library item, or a link
 * inside another node's detail. The detail opens in the sheet at the medium
 * detent and the camera centres the node above it (PhoneShell). It goes
 * through the history (navigation.ts), so back, Android's gesture included,
 * returns to wherever it was opened from. */

/** Opens a node's detail. By default it takes the place of a node detail
 * already showing, as a tap on another node on the map does, and otherwise
 * opens over whatever is showing: the map, search, a tab. With `push`, it
 * opens over the node detail showing, so back returns to it, as a link
 * inside one (its album, its artist, a credit) does. */
export function openPhoneNode(id: number, { push = false }: { push?: boolean } = {}) {
  const overlays = currentSheetOverlays()
  const top = overlays[overlays.length - 1]
  if (top?.kind === 'node' && !push) replaceSheetOverlay({ kind: 'node', id })
  else pushSheetOverlay({ kind: 'node', id })
}

/** Goes back from the node detail showing, to whatever was before it.
 * Returns false, doing nothing, when no node detail is showing. */
export function closePhoneNode(): boolean {
  const overlays = currentSheetOverlays()
  if (overlays[overlays.length - 1]?.kind !== 'node') return false
  popSheetOverlay()
  return true
}

export type PhoneNodeState = {
  id: number | null
  details: NodeDetailsData | null
  tab: DetailsTab
  setTab: (tab: DetailsTab) => void
}

/** The node in the sheet, and its tab, which starts at overview for each
 * new node. Asks for nothing while there's no node. */
export function usePhoneNode(id: number | null, playback: Playback): PhoneNodeState {
  const details = useNodeDetails(id, playback)
  const [tab, setTab] = useState<DetailsTab>('overview')
  const [tabFor, setTabFor] = useState(id)
  if (tabFor !== id) {
    setTabFor(id)
    setTab('overview')
  }
  return { id, details, tab, setTab }
}

/* 6px under the status bar, as the capsule is, 44px tall, and 16px more:
 * where the map shell leaves showing starts, under node detail's controls. */
export const NODE_CONTROLS_CLEARANCE = 66
