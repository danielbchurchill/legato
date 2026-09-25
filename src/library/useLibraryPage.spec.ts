// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mergePage, useLibraryPage, type LibraryPage } from './useLibraryPage'

type Row = { id: number }

describe('mergePage', () => {
  it('sizes a fresh array to total and places items at their absolute offset', () => {
    const next = mergePage<Row>([], 5, 0, [{ id: 1 }, { id: 2 }])
    expect(next).toHaveLength(5)
    expect(next).toEqual([{ id: 1 }, { id: 2 }, undefined, undefined, undefined])
  })

  it('fills a later page into the middle of an already-sized array without disturbing loaded rows', () => {
    const first = mergePage<Row>([], 5, 0, [{ id: 1 }, { id: 2 }])
    const second = mergePage<Row>(first, 5, 3, [{ id: 4 }, { id: 5 }])
    expect(second).toEqual([{ id: 1 }, { id: 2 }, undefined, { id: 4 }, { id: 5 }])
  })

  it('re-sizes rather than splices when total changes, discarding the stale page shape', () => {
    // A query that narrows the result set lands a first page whose total is
    // smaller than whatever was loaded before it — the array has to reset
    // to the new total rather than keep the old (now wrong) length.
    const stale = mergePage<Row>([], 10, 0, [{ id: 1 }])
    const filtered = mergePage<Row>(stale, 2, 0, [{ id: 9 }])
    expect(filtered).toEqual([{ id: 9 }, undefined])
  })

  it('overwrites an existing row when the same offset is merged again', () => {
    const first = mergePage<Row>([], 3, 0, [{ id: 1 }, { id: 2 }, { id: 3 }])
    const refreshed = mergePage<Row>(first, 3, 1, [{ id: 20 }])
    expect(refreshed).toEqual([{ id: 1 }, { id: 20 }, { id: 3 }])
  })
})

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function renderLibraryPage<Row>(entity: 'library/albums' | 'library/tracks', query: string, sort: string, dir: 'asc' | 'desc') {
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root!: Root
  const result: { current: LibraryPage<Row> | null } = { current: null }

  function Harness() {
    result.current = useLibraryPage<Row>(entity, query, sort, dir)
    return null
  }

  act(() => {
    root = createRoot(container)
    root.render(createElement(Harness))
  })

  return { result, unmount: () => act(() => root.unmount()) }
}

// #172: `useLibraryPage` used to only ever learn `total` from a page an
// `ensureRange` call asked for, and `ensureRange` is driven by the
// virtualizer's own visible range — which is sized from `total` in the
// first place. Cold start (fresh mount, nothing scrolled yet) had no way
// into that loop: `total` stayed 0 forever, so the view latched onto its
// empty state and never fetched anything. Fails on that code because
// nothing here ever calls `ensureRange`.
describe('useLibraryPage cold start (#172)', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        json: async () => ({ items: [{ id: 1 }, { id: 2 }], total: 2 }),
      })),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fetches page 0 itself on mount and reports loading until it lands, without any scroll', async () => {
    const { result, unmount } = renderLibraryPage<Row>('library/albums', '', 'title', 'asc')

    expect(result.current!.loading).toBe(true)
    expect(result.current!.total).toBe(0)

    await act(flush)

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(result.current!.loading).toBe(false)
    expect(result.current!.total).toBe(2)
    expect(result.current!.rows).toEqual([{ id: 1 }, { id: 2 }])

    unmount()
  })

  it('re-fetches page 0 when the query changes, going back to loading rather than the stale total', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    let root!: Root
    const result: { current: LibraryPage<Row> | null } = { current: null }

    function Harness({ query }: { query: string }) {
      result.current = useLibraryPage<Row>('library/albums', query, 'title', 'asc')
      return null
    }

    act(() => {
      root = createRoot(container)
      root.render(createElement(Harness, { query: '' }))
    })
    await act(flush)
    expect(result.current!.total).toBe(2)

    act(() => {
      root.render(createElement(Harness, { query: 'zzz' }))
    })
    expect(result.current!.loading).toBe(true)

    await act(flush)
    expect(result.current!.loading).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(2)

    act(() => root.unmount())
  })
})
