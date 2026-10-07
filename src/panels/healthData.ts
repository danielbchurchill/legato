import { useCallback, useEffect, useState } from 'react'
import { useWsEvent } from '../hooks/useWs'
import { API_BASE as API } from '../config/serverHost'
import type { DbInspectorSnapshot } from './DatabaseInspector'

/* Everything Library health shows, from the endpoints that already exist:
 * /stats for the library's size, /db-inspector for the last scan and match
 * quality, /hygiene/worklist and /tag-writes for what needs a look, and
 * /tag-manager for the metadata gaps. Each refetches on the server events
 * that change it. */

export type WorklistItem =
  | {
      type: 'fuzzy_pending'
      fileId: number
      filePath: string
      nodeId: number
      nodeTitle: string
      candidateNodeId: number
      candidateTitle: string
    }
  | { type: 'enrichment_flag'; nodeId: number; nodeTitle: string; note: string | null; updatedAt: string }
  | { type: 'missing_file'; fileId: number; filePath: string; nodeId: number; nodeTitle: string; missingSince: string }
  | { type: 'wont_decode'; fileId: number; filePath: string; nodeId: number; nodeTitle: string; error: string; updatedAt: string }

export type TagWriteStatus = 'pending_review' | 'approved' | 'written' | 'failed' | 'reverted'
export type TagWrite = {
  id: number
  file_id: number
  status: TagWriteStatus
  diff_json: string
  requested_at: string
  written_at: string | null
  reverted_at: string | null
  error_message: string | null
}
export type FieldDiff = { field: string; oldValue: string | number | string[]; newValue: string | number | string[] }

export type Stats = { artists: number; albums: number; tracks: number; totalBytes: number; totalDurationMs: number }

export type GapField = 'bpm' | 'unmatched' | 'label' | 'release_date' | 'release_type'
export const GAP_FIELDS: { field: GapField; chip: string; row: string }[] = [
  { field: 'bpm', chip: 'bpm', row: 'Missing bpm' },
  { field: 'unmatched', chip: 'unmatched', row: 'Unmatched tracks' },
  { field: 'label', chip: 'label', row: 'Missing label' },
  { field: 'release_date', chip: 'release date', row: 'Missing release date' },
  { field: 'release_type', chip: 'type', row: 'Missing release type' },
]
export type GapRow = { id: number; title: string; artist: string | null }

function useFetched<T>(path: string | null, events: string[]): { data: T | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null)
  const reload = useCallback(() => {
    if (!path) return
    fetch(`${API}${path}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((value: T | null) => setData(value))
      .catch(() => undefined)
  }, [path])
  useEffect(reload, [reload])
  useWsEvent(events, reload)
  return { data, reload }
}

const LIBRARY_EVENTS = ['scan:done', 'scan:file', 'hygiene:changed']
// Writing and reverting broadcast; creating a dry-run and discarding one
// don't, so the views that do those reload themselves afterwards.
const TAG_EVENTS = ['tag-write:written', 'tag-write:reverted']

export function useStats() {
  return useFetched<Stats>('/stats', LIBRARY_EVENTS).data
}

export function useDbSnapshot() {
  return useFetched<DbInspectorSnapshot>('/db-inspector', [...LIBRARY_EVENTS, ...TAG_EVENTS]).data
}

export function useWorklist() {
  return useFetched<WorklistItem[]>('/hygiene/worklist', LIBRARY_EVENTS)
}

export function useTagWrites() {
  return useFetched<TagWrite[]>('/tag-writes', TAG_EVENTS)
}

export function useGapRows(field: GapField) {
  return useFetched<GapRow[]>(`/tag-manager?field=${field}`, [...LIBRARY_EVENTS, ...TAG_EVENTS])
}

/* How many tracks each gap holds — one request per field, the five in
 * parallel. */
export function useGapCounts(): Record<GapField, number> | null {
  const [counts, setCounts] = useState<Record<GapField, number> | null>(null)
  const load = useCallback(() => {
    void Promise.all(
      GAP_FIELDS.map(({ field }) =>
        fetch(`${API}/tag-manager?field=${field}`)
          .then((r) => r.json())
          .then((rows: unknown[]) => [field, rows.length] as const)
          .catch(() => [field, 0] as const),
      ),
    ).then((entries) => setCounts(Object.fromEntries(entries) as Record<GapField, number>))
  }, [])
  useEffect(load, [load])
  useWsEvent([...LIBRARY_EVENTS, ...TAG_EVENTS], load)
  return counts
}

export function parseDiff(tagWrite: TagWrite): FieldDiff[] {
  try {
    return JSON.parse(tagWrite.diff_json) as FieldDiff[]
  } catch {
    return []
  }
}

export function formatDiffValue(value: string | number | string[]): string {
  return Array.isArray(value) ? value.join(', ') : String(value)
}

/* "22:31 yesterday", "09:05 today", "Sep 30" — for a server timestamp,
 * which is UTC with no zone marker. */
export function formatWhen(value: string | null | undefined): string | null {
  if (!value) return null
  const date = new Date(`${value.replace(' ', 'T')}${/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? '' : 'Z'}`)
  if (Number.isNaN(date.getTime())) return null
  const time = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((startOf(new Date()) - startOf(date)) / 86_400_000)
  if (days === 0) return `${time} today`
  if (days === 1) return `${time} yesterday`
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/* A library's length: "41 d 7 h", or "17 h 48 m" under a day. */
export function formatLibraryLength(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  return days > 0 ? `${days} d ${hours} h` : `${hours} h ${minutes % 60} m`
}
