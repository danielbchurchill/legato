import { useRef, useState } from 'react'
import { useCoalescedWsEvent } from '../hooks/useCoalescedWsEvent'
import { useFetched, type Stats } from '../panels/healthData'

/* When the Library header's counts and the Artists tab fetch again (#302).
 * Both read the albums table and the track count, which change when a
 * recompute rewrites the albums table and when a merge moves files between
 * recordings. The server sends library:changed after each, with a revision
 * number that only goes up (server/src/libraryRevision.ts), and nothing
 * else here fetches again.
 *
 * Not scan:file, enrich:applied or hygiene:changed. The watcher sends
 * scan:file for every file it reads, and the enrichment worker sends the
 * other two once per job, every few seconds for as long as a drain lasts,
 * and none of those rewrite what the header or the tab reads. GET /stats
 * holds the server's loop for about 0.13 s at 30,000 albums.
 *
 * One socket for the view, and a burst coalesced into one fetch, as the
 * map's own refetch is (canvas/useGraphData.ts). */

/** The library's revision as of its last change, once a burst of changes
 * has gone quiet; 0 until one arrives. */
export function useLibraryChanges(): number {
  const [revision, setRevision] = useState(0)
  // The newest revision the server has sent, which a settled burst shows.
  // An event that isn't newer (sent again, or out of order) is left out.
  const latest = useRef(0)
  useCoalescedWsEvent(['library:changed'], () => setRevision(latest.current), {
    accept: (payload) => {
      const next = (payload as { revision?: unknown } | undefined)?.revision
      if (typeof next !== 'number' || next <= latest.current) return false
      latest.current = next
      return true
    },
  })
  return revision
}

/** GET /stats, fetched again on every `revision`. A failed refetch (a 5xx, a
 * 401, the server gone) keeps the counts already shown rather than going
 * back to "Loading…", and the first fetch is tried again until it answers. */
export function useLibraryStats(revision: number): Stats | null {
  return useFetched<Stats>('/stats', [], { revision, keep: true }).data
}
