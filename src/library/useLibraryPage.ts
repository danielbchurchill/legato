import { useCallback, useEffect, useRef, useState } from 'react'
import { SERVER_HOST } from '../config/serverHost'
import type { SortDir } from './types'

const API = `http://${SERVER_HOST}:8899/api/v1`

// One fetch covers this many rows. DOM virtualization (AlbumsGrid,
// TracksTable) only solves half of "smooth at 30k albums" — it keeps the
// node count down, but a single GET /library/albums for the whole table
// would still ship and JSON-parse 30k rows before the first frame. This
// hook is the other half: it sizes the scrollable area from `total` (known
// after the very first page lands) and fills a sparse array as the
// virtualizer's own visible range asks for it, applying the same
// "load only what's on screen" idea to the network instead of just the DOM.
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
        })
        .catch(() => {
          // Left un-loaded rather than latched as permanently missing — the
          // row keeps rendering its loading placeholder, and scrolling away
          // and back tries the fetch again instead of leaving a hole a
          // manual refresh is the only way out of.
          loadedPages.current.delete(pageIndex)
        })
    },
    [entity, query, sort, dir],
  )

  const ensureRange = useCallback(
    (startIndex: number, endIndex: number) => {
      const firstPage = Math.floor(startIndex / PAGE_SIZE)
      const lastPage = Math.floor(Math.max(startIndex, endIndex) / PAGE_SIZE)
      for (let page = firstPage; page <= lastPage; page++) loadPage(page)
    },
    [loadPage],
  )

  return { rows, total, ensureRange }
}
