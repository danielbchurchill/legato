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
