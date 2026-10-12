import { describe, expect, it } from 'vitest'
import {
  PHONE_LABEL_CAP,
  PHONE_LABEL_MIN_PX,
  choosePhoneLabels,
  compareLabelRank,
  phoneLabelSize,
  placeGreedily,
  type LabelBox,
  type LabelRank,
} from './labelDensity'

const box = (left: number, top: number, width = 60, height = 14): LabelBox => ({ left, top, right: left + width, bottom: top + height })

const rank = (overrides: Partial<LabelRank> = {}): LabelRank => ({
  pinned: false,
  focused: false,
  kindRank: 0,
  records: 0,
  tracks: 0,
  title: '',
  ...overrides,
})

describe('phoneLabelSize', () => {
  it('draws labels at 0.8 of the desktop size', () => {
    expect(phoneLabelSize(20)).toBe(16)
    expect(phoneLabelSize(15)).toBe(12)
  })

  it('never goes under 11px, so both desktop sizes (13 and 11) draw at 11', () => {
    expect(phoneLabelSize(13)).toBe(PHONE_LABEL_MIN_PX)
    expect(phoneLabelSize(11)).toBe(PHONE_LABEL_MIN_PX)
    expect(phoneLabelSize(1)).toBe(PHONE_LABEL_MIN_PX)
  })
})

describe('placeGreedily', () => {
  it('skips a label that overlaps one placed before it, in the order given', () => {
    const placed = placeGreedily([
      { key: 'a', box: box(0, 0) },
      { key: 'b', box: box(30, 5) },
      { key: 'c', box: box(100, 0) },
    ])
    expect([...placed]).toEqual(['a', 'c'])
  })

  it('lets labels that only touch both draw', () => {
    const placed = placeGreedily([
      { key: 'a', box: box(0, 0, 50) },
      { key: 'b', box: box(50, 0, 50) },
      { key: 'c', box: box(0, 14, 50) },
    ])
    expect([...placed]).toEqual(['a', 'b', 'c'])
  })

  it('stops at the cap, without counting skipped labels against it', () => {
    const candidates = [
      { key: 'a', box: box(0, 0) },
      { key: 'a2', box: box(10, 0) },
      { key: 'b', box: box(0, 20) },
      { key: 'c', box: box(0, 40) },
    ]
    expect([...placeGreedily(candidates, 2)]).toEqual(['a', 'b'])
    expect([...placeGreedily(candidates)]).toEqual(['a', 'b', 'c'])
  })
})

describe('compareLabelRank', () => {
  it('puts the pinned node first, whatever else it is', () => {
    const pinnedRecord = rank({ pinned: true, kindRank: 2 })
    const bigArtist = rank({ focused: true, records: 40, tracks: 400 })
    expect(compareLabelRank(pinnedRecord, bigArtist)).toBeLessThan(0)
  })

  it('then the focused cluster, then kind', () => {
    expect(compareLabelRank(rank({ focused: true, kindRank: 2 }), rank({ records: 9 }))).toBeLessThan(0)
    expect(compareLabelRank(rank({ kindRank: 0 }), rank({ kindRank: 1, records: 9 }))).toBeLessThan(0)
  })

  it('ranks artists by records, then tracks, then title', () => {
    const sorted = [
      rank({ title: 'b', records: 2, tracks: 20 }),
      rank({ title: 'a', records: 2, tracks: 20 }),
      rank({ title: 'c', records: 2, tracks: 30 }),
      rank({ title: 'd', records: 5, tracks: 1 }),
    ].sort(compareLabelRank)
    expect(sorted.map((r) => r.title)).toEqual(['d', 'c', 'a', 'b'])
  })
})

describe('choosePhoneLabels', () => {
  it('draws the most important label where two collide, whatever the input order', () => {
    const chosen = choosePhoneLabels([
      { key: 'small', box: box(0, 0), rank: rank({ title: 'small', records: 1 }) },
      { key: 'big', box: box(20, 4), rank: rank({ title: 'big', records: 8 }) },
    ])
    expect([...chosen]).toEqual(['big'])
  })

  it('keeps the selected node even when a bigger artist sits on top of it', () => {
    const chosen = choosePhoneLabels([
      { key: 'artist', box: box(0, 0), rank: rank({ title: 'artist', records: 30 }) },
      { key: 'selected', box: box(10, 2), rank: rank({ title: 'selected', pinned: true, kindRank: 2 }) },
    ])
    expect([...chosen]).toEqual(['selected'])
  })

  it(`draws at most ${PHONE_LABEL_CAP}, the highest ranked`, () => {
    const candidates = Array.from({ length: 40 }, (_, i) => ({
      key: `artist ${i}`,
      box: box(0, i * 20),
      rank: rank({ title: `artist ${i}`, records: i }),
    }))
    const chosen = [...choosePhoneLabels(candidates)]
    expect(chosen).toHaveLength(PHONE_LABEL_CAP)
    expect(chosen[0]).toBe('artist 39')
    expect(chosen.at(-1)).toBe(`artist ${40 - PHONE_LABEL_CAP}`)
  })

  it('draws fewer than the cap when the rest would overlap', () => {
    const candidates = Array.from({ length: 20 }, (_, i) => ({ key: String(i), box: box(i * 3, 0), rank: rank({ records: i }) }))
    expect([...choosePhoneLabels(candidates)]).toEqual(['19'])
  })
})
