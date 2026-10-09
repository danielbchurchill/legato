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
        ok: true,
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

// #302: a refresh after a library change refetches page 0 and the range on
// screen, and a page that lands with a different total drops every other
// page (mergePage). Those pages used to stay marked as fetched, so neither a
// scroll nor the grid's next ask fetched them again, and they stayed
// skeletons until the next change.
describe('useLibraryPage after a refresh moves the total (#302)', () => {
  const PAGE = 150
  // Each request waits until the test answers it, with whatever total the
  // server has by then.
  let pending: { offset: number; answer: (total: number) => void }[]

  beforeEach(() => {
    pending = []
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (input: string) =>
          new Promise((resolve) => {
            const offset = Number(new URL(input).searchParams.get('offset'))
            pending.push({
              offset,
              answer: (total) =>
                resolve({
                  ok: true,
                  json: async () => ({
                    items: Array.from({ length: Math.max(0, Math.min(PAGE, total - offset)) }, (_, i) => ({ id: offset + i })),
                    total,
                  }),
                }),
            })
          }),
      ),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function answer(offset: number, total: number) {
    const index = pending.findIndex((p) => p.offset === offset)
    expect(index).toBeGreaterThanOrEqual(0)
    const [request] = pending.splice(index, 1)
    await act(async () => {
      request.answer(total)
      await flush()
    })
  }

  it('fetches the pages a moved total dropped again, so none stays a skeleton', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    let root!: Root
    const result: { current: LibraryPage<Row> | null } = { current: null }
    function Harness({ revision }: { revision: number }) {
      result.current = useLibraryPage<Row>('library/artists', '', 'name', 'asc', revision)
      return null
    }
    act(() => {
      root = createRoot(container)
      root.render(createElement(Harness, { revision: 0 }))
    })
    await answer(0, 3_000)
    // Scrolled to rows 450-749: pages 3 and 4.
    act(() => result.current!.ensureRange(450, 749))
    await answer(450, 3_000)
    await answer(600, 3_000)

    // The library changes: page 0 and the range on screen go again.
    act(() => root.render(createElement(Harness, { revision: 1 })))
    expect(pending.map((p) => p.offset).sort((a, b) => a - b)).toEqual([0, 450, 600])

    // Page 3 lands with total 2,990, then page 4 with 2,995: each drops the
    // rest, and the range on screen is asked for again.
    await answer(450, 2_990)
    await answer(600, 2_995)
    while (pending.length > 0) await answer(pending[0].offset, 2_995)

    expect(result.current!.total).toBe(2_995)
    const shown = result.current!.rows.slice(450, 750)
    expect(shown.filter((row) => row === undefined)).toHaveLength(0)
    expect(shown[0]).toEqual({ id: 450 })

    // A page scrolled back to later is fetched too.
    act(() => result.current!.ensureRange(150, 299))
    expect(pending.map((p) => p.offset)).toEqual([150])

    act(() => root.unmount())
  })
})
