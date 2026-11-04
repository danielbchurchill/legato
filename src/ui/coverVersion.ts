import { useSyncExternalStore } from 'react'
import { useWsEvent } from '../hooks/useWs'

/* When an album's cover changes (#461: chosen in the cover picker, uploaded,
 * or put back to the automatic one), every cover of it on screen asks for
 * its image again: the library's grid, the player, now playing, playlist
 * mosaics, the map's card and the details panel.
 *
 * They draw /nodes/:id/cover, which the server lets a browser keep for a
 * day, so the same URL would keep showing the old art. So each node has a
 * version, which CoverArt and useCoverColor put in the URL once it's past 0,
 * making a changed cover a new request. The server says which nodes show the
 * art that changed: the album, its tracks and an artist borrowing it
 * (coverDependents, server/src/cover/extract.ts). Every other cover keeps
 * its URL and doesn't blink.
 *
 * The map draws its art by content hash (/covers/:hash) and refetches its
 * graph on the same enrich:applied, so it needs none of this. */

const versions = new Map<number, number>()
const listeners = new Set<() => void>()

// Changes this device is making. The server sends its event before it
// answers the request, so the event usually lands first; either way round,
// a change asks for each cover once.
//  - 'waiting': the request is out and nothing has been fetched again yet.
//  - 'done': fetched again once; the other half of the pair is swallowed.
const local = new Map<number, 'waiting' | 'done'>()
const ECHO_MS = 5000

// Each node once, however many times the list names it.
function bump(nodeIds: readonly number[]): void {
  for (const id of new Set(nodeIds)) versions.set(id, (versions.get(id) ?? 0) + 1)
  for (const listener of listeners) listener()
}

/** Before a request that changes `nodeId`'s cover. */
export function coverChanging(nodeId: number): void {
  local.set(nodeId, 'waiting')
}

/** After it: `nodeIds` show the cover (the server's coverDependents). A
 * change that didn't go through passes `ok` false. */
export function coverChanged(nodeId: number, nodeIds: readonly number[], ok = true): void {
  const state = local.get(nodeId)
  if (!ok || state === 'done') {
    local.delete(nodeId)
    return
  }
  local.set(nodeId, 'done')
  setTimeout(() => {
    if (local.get(nodeId) === 'done') local.delete(nodeId)
  }, ECHO_MS)
  bump([nodeId, ...nodeIds])
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 0 until the node's cover changes, then how many times it has. */
export function coverVersionOf(nodeId: number | null): number {
  return nodeId == null ? 0 : (versions.get(nodeId) ?? 0)
}

export function useCoverVersion(nodeId: number | null): number {
  return useSyncExternalStore(subscribe, () => coverVersionOf(nodeId))
}

/** `url` with the cover version in it, once there is one. */
export function withCoverVersion(url: string, coverVersion: number): string {
  if (coverVersion === 0) return url
  return `${url}${url.includes('?') ? '&' : '?'}v=${coverVersion}`
}

/** The server's word that a cover changed: `enrich:applied` with `kind:
 * "cover"` (server/src/routes/cover.ts). Exported for its spec. */
export function applyCoverEvent(payload: unknown): void {
  const { kind, nodeId, nodeIds } = (payload ?? {}) as { kind?: string; nodeId?: number; nodeIds?: unknown }
  if (kind !== 'cover' || typeof nodeId !== 'number') return
  const state = local.get(nodeId)
  if (state === 'done') {
    local.delete(nodeId)
    return
  }
  if (state === 'waiting') local.set(nodeId, 'done')
  bump([nodeId, ...(Array.isArray(nodeIds) ? nodeIds.filter((id): id is number => typeof id === 'number') : [])])
}

/** A cover changed on the server, from this device or another. Mounted
 * once, by the workspace both layouts share (App.tsx). */
export function useCoverChanges(): void {
  useWsEvent(['enrich:applied'], applyCoverEvent)
}
