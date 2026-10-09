import { useEffect, useRef, useState } from 'react'
import { useWsEvent } from '../hooks/useWs'
import { API_BASE as API } from '../config/serverHost'
import { REFETCH_COALESCE_MS } from '../canvas/useGraphData'
import type { Stats } from '../panels/healthData'

/* When the Library header's counts and the Artists tab fetch again (#302).
 * Both read the albums and artists tables, which change when a recompute
 * rewrites them, so they follow the events that come after one: a scan's
 * (scan:done), an artist-credit split's (enrich:applied, the only event
 * enrich/artistCredit.ts sends), and a hygiene change, a match or a merge
 * (hygiene:changed).
 *
 * Not scan:file. A scan sends one per file it reads, the tables only change
 * at its recompute, and GET /stats holds the server's loop for about 0.15 s
 * at 30,000 albums: a 1,000-file copy refetched on every one was two and a
 * half minutes of a blocked server for each Library view open.
 *
 * One socket for the view, and a burst coalesced into one refetch, as the
 * map's own refetch is (canvas/useGraphData.ts). */

const LIBRARY_CHANGES = ['scan:done', 'enrich:applied', 'hygiene:changed']

/** A count that goes up once a burst of library changes has gone quiet. */
export function useLibraryChanges(): number {
  const [revision, setRevision] = useState(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useWsEvent(LIBRARY_CHANGES, () => {
    if (timerRef.current != null) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      setRevision((n) => n + 1)
    }, REFETCH_COALESCE_MS)
  })
  useEffect(
    () => () => {
      if (timerRef.current != null) clearTimeout(timerRef.current)
    },
    [],
  )
  return revision
}

/** GET /stats, fetched again on every `revision`. A failed refetch (a 5xx, a
 * 401, the server gone) keeps the counts already shown rather than going
 * back to "Loading…", and an answer that arrives after a newer request was
 * sent is dropped. */
export function useLibraryStats(revision: number): Stats | null {
  const [stats, setStats] = useState<Stats | null>(null)
  useEffect(() => {
    let current = true
    fetch(`${API}/stats`)
      .then((r) => (r.ok ? (r.json() as Promise<Stats>) : null))
      .then((value) => {
        if (current && value) setStats(value)
      })
      .catch(() => undefined)
    return () => {
      current = false
    }
  }, [revision])
  return stats
}
