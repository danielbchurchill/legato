import { describe, expect, it } from 'vitest'
import { GROUP_LIMIT, GROUP_ORDER, groupResults, type Item } from './searchData'

const item = (kind: Item['kind'], id: number): Item => ({
  key: `${kind === 'playlist' ? 'p' : 'n'}${id}`,
  kind,
  id,
  title: `${kind} ${id}`,
})

// In the server's rank order (#463): artists, albums, tracks, producers;
// then the playlists matched by name.
const ranked: Item[] = [
  item('artist', 1),
  item('artist', 2),
  item('release', 3),
  item('release', 4),
  item('recording', 5),
  item('recording', 6),
  item('credit', 7),
  item('credit', 8),
  item('playlist', 9),
]

describe('search results, for the palette and the phone alike', () => {
  it('groups artists, albums, tracks, producers, then playlists, on both', () => {
    expect(GROUP_ORDER).toEqual(['artist', 'release', 'recording', 'credit', 'playlist'])
  })

  it('takes the first row as the top result and groups the rest, producers apart from the artists', () => {
    const { top, groups } = groupResults(ranked, 'all')
    expect(top).toEqual(ranked[0])
    expect(groups.map((g) => [g.type, g.rows.map((r) => r.id)])).toEqual([
      ['artist', [2]],
      ['release', [3, 4]],
      ['recording', [5, 6]],
      ['credit', [7, 8]],
      ['playlist', [9]],
    ])
  })

  it('takes an exact match the server put first as the top result, whatever its kind', () => {
    const exact = item('credit', 10)
    const { top, groups } = groupResults([exact, ...ranked], 'all')
    expect(top).toBe(exact)
    expect(groups.find((g) => g.type === 'credit')!.rows.map((r) => r.id)).toEqual([7, 8])
    expect(groups.find((g) => g.type === 'artist')!.rows.map((r) => r.id)).toEqual([1, 2])
  })

  it('keeps each group to its limit', () => {
    const many = Array.from({ length: 20 }, (_, i) => item('recording', i + 1))
    const { top, groups } = groupResults(many, 'all', ['recording'])
    expect(top?.id).toBe(1)
    expect(groups[0].rows).toHaveLength(GROUP_LIMIT.recording)
    expect(groups[0].rows[0].id).toBe(2)
  })

  it('narrows to one kind under a filter, its best match the top result', () => {
    const { top, groups } = groupResults(ranked, 'release')
    expect(top?.id).toBe(3)
    expect(groups).toEqual([{ type: 'release', rows: [ranked[3]] }])
    const producers = groupResults(ranked, 'credit')
    expect(producers.top?.id).toBe(7)
    expect(producers.groups).toEqual([{ type: 'credit', rows: [ranked[7]] }])
  })

  it('finds nothing in nothing', () => {
    expect(groupResults([], 'all', ['artist'])).toEqual({ visible: [], top: null, groups: [{ type: 'artist', rows: [] }] })
  })
})
