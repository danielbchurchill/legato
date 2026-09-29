import { useCallback, useEffect, useRef, useState } from 'react'
import { API_BASE as API } from '../config/serverHost'
import type { SortDir } from './types'

// One fetch covers this many rows. DOM virtualization (AlbumsGrid,
// TracksTable) only solves half of "smooth at 30k albums" — it keeps the
// node count down, but a single GET /library/albums for the whole table
// would still ship and JSON-parse 30k rows before the first frame. This
// hook is the other half: it sizes the scrollable area from `total` (known
// after the very first page lands) and fills a sparse array as the
// virtualizer's own visible range asks for it, applying the same
// "load only what's on screen" idea to the network instead of just the DOM.
//
// Page 0 is fetched by this hook itself, not left for the virtualizer's own
// `ensureRange` to ask for — a virtualizer sizes its scroll range from
// `total`, which starts at 0, so with nothing fetched yet it always asks for
// zero rows and `total` would never learn otherwise (issue #172).
const PAGE_SIZE = 150

// Pulled out of the fetch callback below and exported so the one bit of
// real logic in this hook — splicing one page's worth of rows into the
// right slice of a sparse, `total`-long array — is unit-testable on its own,
// without a React render harness. See useLibraryPage.spec.ts.
export function mergePage<Row>(
  prev: (Row | undefined)[],
  total: number,
  offset: number,
  items: Row[],
): (Row | undefined)[] {
  const next = prev.length === total ? [...prev] : new Array<Row | undefined>(total)
  items.forEach((item, i) => {
    next[offset + i] = item
  })
  return next
}

export type LibraryPage<Row> = {
  /** Sparse: `rows[i]` is `undefined` until the page covering index `i` has
   * loaded. Always `total` long once the first page has landed, so callers
   * can size a virtualizer immediately without waiting on every row. */
  rows: (Row | undefined)[]
  total: number
  /** True until page 0 has returned for the current entity/query/sort/dir —
   * before that, `total === 0` means "not known yet", not "empty", so
   * callers must not render an empty state off it alone. */
  loading: boolean
  /** DESIGN.md's indeterminate-progress rule (see useLyrics.ts/LibrarySetup.tsx
   * for the same pattern elsewhere): under ~400ms a loading state shown just
   * to prove the wait happened costs more attention than the wait itself, so
   * callers should render nothing until this flips. */
  waitVisible: boolean
  /** Past ~800ms silence reads as broken — one non-looping state change
   * (e.g. a label going from muted to ink), not a spinner. */
  waitLong: boolean
  /** Call with the currently visible index range (inclusive); loads
   * whichever pages that range touches and haven't been requested yet. */
  ensureRange: (startIndex: number, endIndex: number) => void
}

/** `entity` is a URL segment (`library/albums` or `library/tracks`), not a
 * free string, so a typo here fails at compile time rather than as a 404
 * nobody notices until the view stays empty. */
export function useLibraryPage<Row>(
  entity: 'library/albums' | 'library/tracks',
  query: string,
  sort: string,
  dir: SortDir,
): LibraryPage<Row> {
  const [rows, setRows] = useState<(Row | undefined)[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const loadedPages = useRef<Set<number>>(new Set())
  // Bumped on every filter/sort change so a page fetch that was already in
  // flight when the user typed the next character lands as a no-op instead
  // of splicing stale rows into the new result set.
  const generation = useRef(0)

  useEffect(() => {
    generation.current += 1
    loadedPages.current = new Set()
    setRows([])
    setTotal(0)
    setLoading(true)
  }, [entity, query, sort, dir])

  const loadPage = useCallback(
    (pageIndex: number) => {
      if (loadedPages.current.has(pageIndex)) return
      loadedPages.current.add(pageIndex)
      const gen = generation.current
      const offset = pageIndex * PAGE_SIZE

      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset), sort, dir })
      if (query) params.set('q', query)

      fetch(`${API}/${entity}?${params}`)
        .then((r) => r.json())
        .then((data: { items: Row[]; total: number }) => {
          if (gen !== generation.current) return
          setTotal(data.total)
          setRows((prev) => mergePage(prev, data.total, offset, data.items))
          if (pageIndex === 0) setLoading(false)
        })
        .catch(() => {
          // Left un-loaded rather than latched as permanently missing — the
          // row keeps rendering its loading placeholder, and scrolling away
          // and back tries the fetch again instead of leaving a hole a
          // manual refresh is the only way out of. Page 0 specifically is
          // never retried by a scroll, so `loading` is left true rather than
          // false — a stuck loading state is a truer picture of a real fetch
          // failure than snapping to the empty state ("no albums yet") would
          // be for a library that's actually full.
          loadedPages.current.delete(pageIndex)
        })
    },
    [entity, query, sort, dir],
  )

  // Sizes the virtualizer from `total` immediately instead of waiting on it
  // to ask for a range first — see this file's header comment for why that
  // wait was a deadlock (issue #172).
  useEffect(() => {
    loadPage(0)
  }, [loadPage])

  const ensureRange = useCallback(
    (startIndex: number, endIndex: number) => {
      const firstPage = Math.floor(startIndex / PAGE_SIZE)
      const lastPage = Math.floor(Math.max(startIndex, endIndex) / PAGE_SIZE)
      for (let page = firstPage; page <= lastPage; page++) loadPage(page)
    },
    [loadPage],
  )

  // Same MO-11 wait timing as useLyrics.ts/LibrarySetup.tsx: nothing for the
  // first ~400ms (most local fetches never reach it), one non-looping change
  // past ~800ms.
  const [waitVisible, setWaitVisible] = useState(false)
  const [waitLong, setWaitLong] = useState(false)
  useEffect(() => {
    if (!loading) {
      setWaitVisible(false)
      setWaitLong(false)
      return
    }
    const shortTimer = setTimeout(() => setWaitVisible(true), 400)
    const longTimer = setTimeout(() => setWaitLong(true), 800)
    return () => {
      clearTimeout(shortTimer)
      clearTimeout(longTimer)
    }
  }, [loading])

  return { rows, total, loading, waitVisible, waitLong, ensureRange }
}
