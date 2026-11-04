import { describe, expect, it } from 'vitest'
import { albumLinks, picardNote, PICARD_SITE } from './gapLinks'

const MBID = 'B84EE12A-09EF-421B-82DE-0441A926375B'

describe('albumLinks', () => {
  it('links the MusicBrainz release, and opens it in a running Picard, when the album has a release id', () => {
    const links = albumLinks({ title: 'Abbey Road', artist: 'The Beatles', releaseMbid: MBID }, { localPicard: true })
    expect(links.musicbrainz).toEqual({
      href: 'https://musicbrainz.org/release/b84ee12a-09ef-421b-82de-0441a926375b',
      label: 'MusicBrainz release',
    })
    expect(links.picard).toEqual({
      href: 'http://127.0.0.1:8000/openalbum?id=b84ee12a-09ef-421b-82de-0441a926375b',
      label: 'Open in Picard',
      opensRelease: true,
    })
  })

  it('searches MusicBrainz for the release and artist when there is no id, quoting what needs it', () => {
    const links = albumLinks({ title: 'Say "Yes"', artist: 'A\\B', releaseMbid: null }, { localPicard: true })
    const url = new URL(links.musicbrainz.href)
    expect(url.origin + url.pathname).toBe('https://musicbrainz.org/search')
    expect(url.searchParams.get('query')).toBe('release:"Say \\"Yes\\"" AND artist:"A\\\\B"')
    expect(url.searchParams.get('type')).toBe('release')
    expect(url.searchParams.get('method')).toBe('advanced')
    expect(links.picard).toEqual({ href: PICARD_SITE, label: 'Picard', opensRelease: false })
  })

  it('searches without an artist it doesn’t know', () => {
    const url = new URL(albumLinks({ title: 'Untitled', artist: null, releaseMbid: null }, { localPicard: true }).musicbrainz.href)
    expect(url.searchParams.get('query')).toBe('release:"Untitled"')
  })

  it('searches Discogs for the artist and title', () => {
    const url = new URL(albumLinks({ title: 'Hot Rats', artist: 'Frank Zappa', releaseMbid: MBID }, { localPicard: true }).discogs.href)
    expect(url.origin + url.pathname).toBe('https://www.discogs.com/search/')
    expect(url.searchParams.get('q')).toBe('Frank Zappa Hot Rats')
    expect(url.searchParams.get('type')).toBe('release')
  })

  it('sends a phone to Picard’s site, since it can’t run Picard', () => {
    expect(albumLinks({ title: 'A', artist: null, releaseMbid: MBID }, { localPicard: false }).picard.href).toBe(PICARD_SITE)
  })

  it('treats a malformed release id as none', () => {
    const links = albumLinks({ title: 'A', artist: null, releaseMbid: 'not-an-id' }, { localPicard: true })
    expect(links.musicbrainz.label).toBe('Search MusicBrainz')
    expect(links.picard.opensRelease).toBe(false)
  })
})

describe('picardNote', () => {
  it('says what Picard is, in one line, for each case', () => {
    for (const note of [
      picardNote({ opensRelease: true, localPicard: true }),
      picardNote({ opensRelease: false, localPicard: true }),
      picardNote({ opensRelease: false, localPicard: false }),
    ]) {
      expect(note).toMatch(/^Picard is MusicBrainz's free tagger/)
      expect(note).not.toContain('\n')
    }
  })
})
