import { isSameArtist } from "./artistName.js";
import { USER_AGENT } from "./mbClient.js";

// Artist photographs. MusicBrainz has none of its own — the Cover Art Archive
// covers releases, and an artist there is a name, a set of relations and
// nothing you can look at — so this is a different service from the rest of
// the enrichment pipeline.
//
// Deezer's public search needs no key and no registration, which is the whole
// reason it is the one wired up: an artist photo that only works after
// somebody registers an OAuth application is a feature that doesn't work.
// (Tidal's open API, the other candidate, requires exactly that.) The images
// are 1000px square and consistently framed, which suits a circular node.
//
// Rate limiting: Deezer's documented ceiling is 50 requests per 5 seconds,
// which the enrichment queue cannot approach — it drains one job at a time
// and every job in front of this one is gated by MusicBrainz's own 1/sec
// throttle. Nothing here needs a throttle of its own.
const API_ROOT = "https://api.deezer.com";

export type ArtistImage = {
  bytes: Buffer;
  mime: string | null;
  /** The image URL, kept as provenance — it also records the provider. */
  sourceUrl: string;
};

type DeezerArtist = {
  name?: string;
  picture_xl?: string;
};

// Deezer answers for an artist with no photograph on file by handing back the
// same URL shape with the image id missing entirely:
//
//   https://cdn-images.dzcdn.net/images/artist//1000x1000-000000-80-0-0.jpg
//
// which serves a grey silhouette placeholder, HTTP 200. Storing that would put
// a stock outline on the node and — worse — record it as art, so the node
// would never be looked at again. The empty path segment is the tell.
export function isPlaceholderImageUrl(url: string): boolean {
  return /\/images\/artist\/\/|\/images\/artist\/?$/.test(url);
}

// The best photo for a name, or null when Deezer has no confident answer.
// Exported separately from the download so the matching half is testable
// without a network call.
export function pickArtistImageUrl(localName: string, results: DeezerArtist[]): string | null {
  for (const result of results) {
    if (!result.name || !result.picture_xl) continue;
    if (!isSameArtist(localName, result.name)) continue;
    if (isPlaceholderImageUrl(result.picture_xl)) return null; // right artist, no photo — don't keep looking
    return result.picture_xl;
  }
  return null;
}

// Deliberately searches on the plain artist name rather than anything derived:
// Deezer has no MBID to look up by, so the name is the only key there is. The
// caller is responsible for having already decided the name refers to a single
// artist (enrich/artistName.ts) — a search for "Pussy Riot; Slayyyter" returns
// confident-looking results for neither of them.
export async function fetchArtistImage(name: string): Promise<ArtistImage | null> {
  const url = `${API_ROOT}/search/artist?${new URLSearchParams({ q: name, limit: "5" })}`;
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`Deezer artist search failed: ${res.status} ${res.statusText}`);
  }

  const body = (await res.json()) as { data?: DeezerArtist[] };
  const imageUrl = pickArtistImageUrl(name, body.data ?? []);
  if (!imageUrl) return null;

  const image = await fetch(imageUrl, { headers: { "User-Agent": USER_AGENT } });
  if (!image.ok) {
    throw new Error(`Deezer artist image fetch failed: ${image.status} ${image.statusText}`);
  }

  return {
    bytes: Buffer.from(await image.arrayBuffer()),
    mime: image.headers.get("content-type"),
    sourceUrl: imageUrl,
  };
}

// Issue #461: album covers, for the cover picker only. The search is the
// same keyless API as the artist photos above and needs no throttle of its
// own for the same reason: the picker asks once or twice each time it opens,
// nowhere near Deezer's 50 requests per 5 seconds.
//
// An album's art is named by `md5_image`, and every size of it lives under
// one path on Deezer's CDN, so the md5 is all a candidate needs to carry:
// https://cdn-images.dzcdn.net/images/cover/{md5}/1000x1000-000000-80-0-0.jpg
// is the album's cover_xl, the largest Deezer serves.
export type DeezerAlbum = {
  id: number;
  title: string;
  artist: string | null;
  md5: string;
  recordType: string | null;
  tracks: number | null;
};

type RawDeezerAlbum = {
  id?: number;
  title?: string;
  md5_image?: string;
  cover_xl?: string;
  record_type?: string;
  nb_tracks?: number;
  artist?: { name?: string };
};

const MD5 = /^[0-9a-f]{32}$/;

export function parseDeezerAlbums(data: { data?: RawDeezerAlbum[] }): DeezerAlbum[] {
  return (data.data ?? []).flatMap((album) => {
    // An album with no art answers with an empty md5 and a cover URL with
    // an empty path segment, the album twin of isPlaceholderImageUrl.
    const md5 = album.md5_image ?? "";
    if (album.id == null || !album.title || !MD5.test(md5)) return [];
    return [
      {
        id: album.id,
        title: album.title,
        artist: album.artist?.name ?? null,
        md5,
        recordType: album.record_type ?? null,
        tracks: album.nb_tracks ?? null,
      },
    ];
  });
}

export function deezerCoverUrl(md5: string, px: 250 | 500 | 1000): string {
  return `https://cdn-images.dzcdn.net/images/cover/${md5}/${px}x${px}-000000-80-0-0.jpg`;
}

// `query` is Deezer's own search syntax: `artist:"…" album:"…"` narrows to
// both fields, a bare string searches everything.
export async function searchDeezerAlbums(query: string): Promise<DeezerAlbum[]> {
  const url = `${API_ROOT}/search/album?${new URLSearchParams({ q: query, limit: "25" })}`;
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`Deezer album search failed: ${res.status} ${res.statusText}`);
  }
  // Deezer reports a refusal (over its quota, say) as a 200 with an error
  // object, which would otherwise read as "no albums".
  const body = (await res.json()) as { data?: RawDeezerAlbum[]; error?: { message?: string } };
  if (body.error) throw new Error(`Deezer album search failed: ${body.error.message ?? "an error"}`);
  return parseDeezerAlbums(body);
}
