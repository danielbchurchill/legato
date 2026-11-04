import { useCallback, useEffect, useRef, useState } from 'react'
import { useWsEvent } from '../hooks/useWs'
import { useCoalescedWsEvent } from '../hooks/useCoalescedWsEvent'
import { API_BASE as API } from '../config/serverHost'
import { useReconnectEpoch } from '../connect/reconnect'
import type { DbInspectorSnapshot } from './DatabaseInspector'

/* Everything Library health shows, from the endpoints that already exist:
 * /stats for the library's size, /db-inspector for the last scan and match
 * quality, /hygiene/worklist and /tag-writes for what needs a look, and
 * /tag-manager for the metadata gaps, grouped by album and paged. Each refetches on the server events
 * that change it, and after an outage (#119), whose events never arrived. */

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
/* The kinds of gap, in the chips' order. BPM is last and off by default
 * (#469): a tempo is a track's own, rarely tagged, and it buried the gaps
 * that matter under thousands of rows. */
export const GAP_FIELDS: { field: GapField; chip: string; row: string }[] = [
  { field: 'unmatched', chip: 'unmatched', row: 'Unmatched tracks' },
  { field: 'label', chip: 'label', row: 'Missing label' },
  { field: 'release_date', chip: 'release date', row: 'Missing release date' },
  { field: 'release_type', chip: 'type', row: 'Missing release type' },
  { field: 'bpm', chip: 'bpm', row: 'Missing bpm' },
]
export const DEFAULT_GAP_KINDS: GapField[] = ['unmatched', 'label', 'release_date', 'release_type']
/* What one value can fill for a whole album: the album's own facts. */
export const ALBUM_FILL_FIELDS: GapField[] = ['label', 'release_date', 'release_type']

export type GapSort = 'artist' | 'album' | 'gaps' | 'plays'
export type GapSortDir = 'asc' | 'desc'
/** How the gaps list is filtered and ordered. Kept by whoever shows the
 * list, so it survives the list being closed and opened again. */
export type GapView = { kinds: GapField[]; sort: GapSort; dir: GapSortDir; artist: string }
export const DEFAULT_GAP_VIEW: GapView = { kinds: DEFAULT_GAP_KINDS, sort: 'gaps', dir: 'desc', artist: '' }

export type GapCounts = Record<GapField, number>
/* Mirrors server/src/routes/tag-manager.ts's GapAlbum, GapTrack and GapFile. */
export type GapAlbum = {
  id: number | null
  title: string | null
  artist: string | null
  tracks: number
  gaps: number
  byKind: Partial<Record<GapField, number>>
  plays: number
  releaseMbid: string | null
}
export type GapTrack = {
  id: number
  title: string
  artist: string | null
  discNo: number | null
  trackNo: number | null
  missing: GapField[]
  plays: number
  files: { id: number; missing: GapField[] }[]
}
export type GapFile = { id: number; trackId: number; missing: GapField[] }
export type Paged<T> = { total: number; items: T[] }

// The first fetch's retries, when `keep` is set: 1 s, 2 s, 4 s, … then
// every 30 s until one succeeds.
const FIRST_RETRY_MS = 1_000
const MAX_RETRY_MS = 30_000

type FetchedOptions = {
  /** Fetched again whenever this changes, as well as on `events`. */
  revision?: number
  /** A failed fetch (a 5xx, a 401, the server gone) keeps what was fetched
   * before, rather than going back to null. Until something has been
   * fetched, it tries again on a backoff, because the event that would
   * fetch again may not come for days, and a failure that isn't an outage
   * (a 500 from a server that's up) gets no resync after it (#119). */
  keep?: boolean
}

/** GET `path`, fetched again on each of `events`. An answer that arrives
 * after a newer request was sent is dropped. */
export function useFetched<T>(
  path: string | null,
  events: string[],
  { revision = 0, keep = false }: FetchedOptions = {},
): { data: T | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null)
  const latest = useRef(0)
  const fetched = useRef(false)
  const retry = useRef<{ timer: ReturnType<typeof setTimeout> | null; delay: number }>({ timer: null, delay: FIRST_RETRY_MS })
  const reloadRef = useRef<() => void>(() => undefined)

  const reload = useCallback(() => {
    if (!path) return
    const request = ++latest.current
    if (retry.current.timer != null) clearTimeout(retry.current.timer)
    retry.current.timer = null
    const failed = () => {
      if (request !== latest.current || !keep || fetched.current) return
      retry.current.timer = setTimeout(() => reloadRef.current(), retry.current.delay)
      retry.current.delay = Math.min(retry.current.delay * 2, MAX_RETRY_MS)
    }
    fetch(`${API}${path}`)
      .then((r) => (r.ok ? (r.json() as Promise<T>) : null))
      .then((value) => {
        if (request !== latest.current) return
        if (value === null) {
          if (!keep) setData(null)
          failed()
          return
        }
        fetched.current = true
        setData(value)
      })
      .catch(failed)
  }, [path, keep])
  reloadRef.current = reload

  // Again after an outage (#119), whose events never arrived.
  const reconnects = useReconnectEpoch()
  useEffect(() => {
    reload()
  }, [reload, revision, reconnects])
  useEffect(
    () => () => {
      if (retry.current.timer != null) clearTimeout(retry.current.timer)
    },
    [],
  )
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

/** The gaps list and its counts fetch again once a burst of library or tag
 * events has gone quiet, not on each one: a scan sends scan:file for every
 * file it reads. */
export function useGapRevision(): number {
  const [revision, setRevision] = useState(0)
  useCoalescedWsEvent([...LIBRARY_EVENTS, ...TAG_EVENTS], () => setRevision((r) => r + 1))
  return revision
}

/** How many tracks each kind of gap is on, from one query (#469), for an
 * artist's tracks when there's a search. Fetched again on each `revision`
 * (useGapRevision). */
export function useGapCounts(artist: string, revision: number): GapCounts | null {
  const query = artist.trim() ? `?${new URLSearchParams({ artist: artist.trim() })}` : ''
  return useFetched<GapCounts>(`/tag-manager/counts${query}`, [], { revision, keep: true }).data
}

/** The query string for a gaps view, without the page. */
export function gapQuery(view: GapView): string {
  const params = new URLSearchParams({ kinds: view.kinds.join(','), sort: view.sort, dir: view.dir })
  if (view.artist.trim()) params.set('artist', view.artist.trim())
  return params.toString()
}

export const GAP_PAGE = 50

/** A list the server pages: the first page of `path` (a path with a query
 * string), then a page more on each `more()`. A new path starts again from
 * its first page. A change elsewhere (`revision`, or the server coming back)
 * fetches the pages already shown again, so rows that were fixed leave and
 * the total stays true; an answer overtaken by a newer request is dropped. */
export function usePaged<T>(path: string | null, revision: number, pageSize = GAP_PAGE) {
  const [list, setList] = useState<{ path: string; total: number; items: T[] } | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const latest = useRef(0)
  const shown = useRef({ path: null as string | null, count: 0 })
  const reconnects = useReconnectEpoch()

  const page = useCallback(
    (p: string, offset: number, limit: number) =>
      fetch(`${API}${p}${p.includes('?') ? '&' : '?'}offset=${offset}&limit=${limit}`).then((r) => {
        if (!r.ok) throw new Error(`${r.status}`)
        return r.json() as Promise<Paged<T>>
      }),
    [],
  )

  // The first page of a new path, or every page shown so far again.
  useEffect(() => {
    if (!path) return
    const request = ++latest.current
    const pages = shown.current.path === path ? Math.max(1, Math.ceil(shown.current.count / pageSize)) : 1
    Promise.all(Array.from({ length: pages }, (_, i) => page(path, i * pageSize, pageSize)))
      .then((answers) => {
        if (request !== latest.current) return
        const items = answers.flatMap((a) => a.items)
        shown.current = { path, count: items.length }
        setList({ path, total: answers[0]?.total ?? 0, items })
      })
      .catch(() => undefined)
  }, [path, revision, reconnects, page, pageSize])

  const more = useCallback(() => {
    const current = list
    if (!current || current.items.length >= current.total || loadingMore) return
    const request = ++latest.current
    setLoadingMore(true)
    page(current.path, current.items.length, pageSize)
      .then((answer) => {
        if (request !== latest.current) return
        const items = [...current.items, ...answer.items]
        shown.current = { path: current.path, count: items.length }
        setList({ path: current.path, total: answer.total, items })
      })
      .catch(() => undefined)
      .finally(() => setLoadingMore(false))
  }, [list, loadingMore, page, pageSize])

  // Until the new path's first page arrives, the old path's rows aren't
  // shown as if they answered it.
  const current = list && list.path === path ? list : null
  return { total: current?.total ?? null, items: current?.items ?? null, more, loadingMore }
}

/** The albums with gaps of the view's kinds, a page at a time. */
export function useGapAlbums(view: GapView, revision: number) {
  return usePaged<GapAlbum>(view.kinds.length > 0 ? `/tag-manager/albums?${gapQuery(view)}` : null, revision)
}

/** An album's tracks with gaps, a page at a time; `albumId` null is the
 * tracks with no album. */
export function useGapTracks(albumId: number | null, view: GapView, revision: number) {
  const params = new URLSearchParams({ kinds: view.kinds.join(',') })
  if (view.artist.trim()) params.set('artist', view.artist.trim())
  return usePaged<GapTrack>(view.kinds.length > 0 ? `/tag-manager/albums/${albumId ?? 'none'}/tracks?${params}` : null, revision, 100)
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
