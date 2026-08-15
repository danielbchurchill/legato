import { USER_AGENT } from "../enrich/mbClient.js";

export type LrclibResult = {
  plainLyrics: string | null;
  syncedLyrics: string | null;
  instrumental: boolean;
};

export type LrclibQuery = {
  trackName: string;
  artistName: string;
  albumName: string | null;
  durationSec: number | null;
};

// LRCLIB matches by track/artist/album/duration, not MBID — there is no
// stable ID to key a lookup on going in, only a best-effort text match, the
// same reason MusicBrainz enrichment falls back to textSearch.ts for
// recordings without one. No API key: LRCLIB's whole appeal is being free
// and open.
export async function fetchLrclibLyrics(query: LrclibQuery): Promise<LrclibResult | null> {
  const params = new URLSearchParams({
    track_name: query.trackName,
    artist_name: query.artistName,
  });
  if (query.albumName) params.set("album_name", query.albumName);
  if (query.durationSec != null) params.set("duration", String(query.durationSec));

  const res = await fetch(`https://lrclib.net/api/get?${params}`, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`LRCLIB fetch failed: ${res.status} ${res.statusText}`);
  }

  const body = (await res.json()) as {
    plainLyrics: string | null;
    syncedLyrics: string | null;
    instrumental: boolean;
  };
  return {
    plainLyrics: body.plainLyrics ?? null,
    syncedLyrics: body.syncedLyrics ?? null,
    instrumental: body.instrumental ?? false,
  };
}
