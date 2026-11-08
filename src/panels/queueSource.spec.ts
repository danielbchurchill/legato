import { describe, expect, it } from 'vitest'
import { sourceLabel } from './queueSource'

describe('"Playing from …"', () => {
  it("names an artist's queue for the artist (#357)", () => {
    expect(sourceLabel({ kind: 'artist', nodeId: 1, name: 'Dylan Moss' }, 'Dylan Moss Live', new Map())).toBe('Dylan Moss')
  })

  it('names the rest as before: the album, the playlist, the shuffled library, or nothing', () => {
    expect(sourceLabel({ kind: 'release', nodeId: 2 }, 'Dylan Moss Live', new Map())).toBe('Dylan Moss Live')
    expect(sourceLabel({ kind: 'playlist', playlistId: 7 }, null, new Map([[7, 'Road trip']]))).toBe('Road trip')
    expect(sourceLabel({ kind: 'library' }, null, new Map())).toBe('your library, shuffled')
    expect(sourceLabel(null, 'Dylan Moss Live', new Map())).toBeNull()
  })
})
