import { describe, expect, it } from 'vitest'
import { GROUP_LIMIT, filterOf, groupResults, type Item } from './searchData'

const item = (kind: Item['kind'], id: number): Item => ({
  key: `${kind === 'playlist' ? 'p' : 'n'}${id}`,
  kind,
  id,
  title: `${kind} ${id}`,
})

// In the server's rank order, best first.
const ranked: Item[] = [
  item('artist', 1),
  item('credit', 2),
  item('recording', 3),
  item('release', 4),
  item('recording', 5),
  item('release', 6),
  item('playlist', 7),
]

describe('search results, for the palette and the phone alike', () => {
  it('files producers and engineers with the artists', () => {
    expect(filterOf('credit')).toBe('artist')
    expect(filterOf('release')).toBe('release')
  })

  it('takes the best match as the top result and groups the rest in the order asked', () => {
    const phone = groupResults(ranked, 'all', ['release', 'artist', 'recording', 'playlist'])
    expect(phone.top).toEqual(ranked[0])
    expect(phone.groups.map((g) => [g.type, g.rows.map((r) => r.id)])).toEqual([
      ['release', [4, 6]],
      ['artist', [2]],
      ['recording', [3, 5]],
      ['playlist', [7]],
    ])
    const palette = groupResults(ranked, 'all', ['artist', 'release', 'recording', 'playlist'])
    expect(palette.top).toEqual(phone.top)
    expect(palette.groups.map((g) => g.type)).toEqual(['artist', 'release', 'recording', 'playlist'])
  })

  it('keeps each group to its limit', () => {
    const many = Array.from({ length: 20 }, (_, i) => item('recording', i + 1))
    const { top, groups } = groupResults(many, 'all', ['recording'])
    expect(top?.id).toBe(1)
    expect(groups[0].rows).toHaveLength(GROUP_LIMIT.recording)
    expect(groups[0].rows[0].id).toBe(2)
  })

  it('narrows to one kind under a filter, its best match the top result', () => {
    const { top, groups } = groupResults(ranked, 'release', ['artist', 'release'])
    expect(top?.id).toBe(4)
    expect(groups).toEqual([{ type: 'release', rows: [ranked[5]] }])
  })

  it('finds nothing in nothing', () => {
    expect(groupResults([], 'all', ['artist'])).toEqual({ visible: [], top: null, groups: [{ type: 'artist', rows: [] }] })
  })
})
