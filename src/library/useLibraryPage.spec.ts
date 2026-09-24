import { describe, expect, it } from 'vitest'
import { mergePage } from './useLibraryPage'

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
