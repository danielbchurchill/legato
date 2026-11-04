/* Where to look up an album's missing tags (#469): MusicBrainz, Discogs and
 * Picard. Plain links that open in the browser. The server contacts none of
 * them, so nothing here needs a line on legato.fm/privacy: it's the person
 * who follows a link. */

export type LinkAlbum = { title: string; artist: string | null; releaseMbid: string | null }

export type AlbumLinks = {
  musicbrainz: { href: string; label: string }
  discogs: { href: string; label: string }
  picard: { href: string; label: string; opensRelease: boolean }
}

/* Picard's browser integration: a running Picard listens on this port, on
 * this computer only, and /openalbum loads a release by its MusicBrainz id.
 * 8000 is Picard's default (picard/const: BROWSER_INTEGRATION_MIN_PORT), the
 * same address musicbrainz.org's green "tagger" buttons call. A Picard that
 * found 8000 taken moves up a port, which this link can't know. */
export const PICARD_OPEN_ALBUM = 'http://127.0.0.1:8000/openalbum'
export const PICARD_SITE = 'https://picard.musicbrainz.org/'

const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/* A phrase for MusicBrainz's advanced search, in Lucene's quotes. */
function phrase(text: string): string {
  return `"${text.replace(/[\\"]/g, (c) => `\\${c}`)}"`
}

/** The album's links. `localPicard` is false on a phone, which can't run
 * Picard, so its Picard link is Picard's own site. */
export function albumLinks(album: LinkAlbum, { localPicard }: { localPicard: boolean }): AlbumLinks {
  const mbid = album.releaseMbid && MBID.test(album.releaseMbid) ? album.releaseMbid.toLowerCase() : null
  const query = [`release:${phrase(album.title)}`, album.artist ? `artist:${phrase(album.artist)}` : null].filter(Boolean).join(' AND ')
  const words = [album.artist, album.title].filter(Boolean).join(' ')
  return {
    musicbrainz: mbid
      ? { href: `https://musicbrainz.org/release/${mbid}`, label: 'MusicBrainz release' }
      : {
          href: `https://musicbrainz.org/search?${new URLSearchParams({ query, type: 'release', method: 'advanced' })}`,
          label: 'Search MusicBrainz',
        },
    discogs: { href: `https://www.discogs.com/search/?${new URLSearchParams({ q: words, type: 'release' })}`, label: 'Search Discogs' },
    picard:
      mbid && localPicard
        ? { href: `${PICARD_OPEN_ALBUM}?${new URLSearchParams({ id: mbid })}`, label: 'Open in Picard', opensRelease: true }
        : { href: PICARD_SITE, label: 'Picard', opensRelease: false },
  }
}

/** The one line under the links that says what Picard is. */
export function picardNote({ opensRelease, localPicard }: { opensRelease: boolean; localPicard: boolean }): string {
  if (opensRelease) return "Picard is MusicBrainz's free tagger. With it open on this computer, the link loads this release into it."
  if (!localPicard) return "Picard is MusicBrainz's free tagger, for a computer. It finds the release and writes its tags to your files."
  return "Picard is MusicBrainz's free tagger. It finds the release from your files and writes its tags."
}
