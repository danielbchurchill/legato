// Required by MusicBrainz's API usage policy: a real UA identifying the
// application plus contact info, not a browser-spoofed or generic string.
// Exported so coverArchive.ts's Cover Art Archive requests (same MetaBrainz
// Foundation, separate service, no shared rate limit) send the same
// courtesy identification rather than inventing a second UA string.
export const USER_AGENT = "Legato/0.1.0 (hello@legato.fm)";
const API_ROOT = "https://musicbrainz.org/ws/2";

// MusicBrainz rate-limits by IP at roughly 1 req/sec — this throttle is
// process-global (module-level, not per-call) since every enrichment
// request in this server shares the same limit regardless of which job
// triggered it.
const MIN_INTERVAL_MS = 1100;
let lastRequestAt = 0;

async function throttle(): Promise<void> {
  const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();
}

// One recording can appear on several distinct releases (a studio LP, a
// live bootleg, a box set...) — textSearch.ts scores each and takes the
// best match, the same way Picard weighs every release a recording
// belongs to rather than picking one arbitrarily.
export type MbReleaseCandidate = {
  title: string | null;
  releaseType: string | null; // release-group's primary-type: "Album", "Live", "Compilation", ...
  date: string | null;
  trackCount: number | null; // the medium's own track-count, not summed across discs
  trackNo: number | null;
};

export type MbRecordingCandidate = {
  mbid: string;
  score: number;
  title: string;
  artist: string | null;
  durationMs: number | null;
  releases: MbReleaseCandidate[];
};

export type RecordingSearchInput = {
  artist: string;
  title: string;
  album?: string | null;
  trackNo?: number | null;
  totalTracks?: number | null;
  date?: string | null; // a full date string; only the leading year feeds the query
};

function escapeLucene(value: string): string {
  // MusicBrainz search queries are Lucene syntax — escape characters that
  // would otherwise break the query or let user-derived tag text (not
  // actually untrusted here, but still arbitrary strings) act as syntax.
  return value.replace(/([+\-&|!(){}[\]^"~*?:\\/])/g, "\\$1");
}

function extractYear(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const match = /^(\d{4})/.exec(dateStr);
  return match ? Number(match[1]) : null;
}

// M-2: recording+artist alone returns everything with that title by that
// artist — for a real case in this library, "Visions of Johanna"/"Bob
// Dylan", that's 196 candidates, live bootlegs and outtakes included,
// every one scored 100 by MB's own text relevance. Widening the query
// with what the local tags already hold cuts that to 11 (confirmed live
// against the real API while building this).
//
// recording/artist/release are required (AND) — release narrows hugely
// (196 -> 11 for the case above) without meaningfully risking a false
// negative, since Lucene's phrase matching tolerates the small
// punctuation/casing drift real tags have against MB's title. tnum/
// tracks/date are left as bare, unjoined terms instead: Lucene's default
// operator for the public search index is OR, so they boost MB's own
// relevance score for a release that matches without excluding a
// recording whose *other* releases just don't happen to carry that
// value — confirmed live: adding `date:1966` as a required AND dropped
// the same query from 11 candidates to 1, and not the correct one.
export function buildRecordingQuery(input: RecordingSearchInput): string {
  const required = [`recording:"${escapeLucene(input.title)}"`, `artist:"${escapeLucene(input.artist)}"`];
  if (input.album) required.push(`release:"${escapeLucene(input.album)}"`);

  const boosts: string[] = [];
  if (input.trackNo != null) boosts.push(`tnum:${input.trackNo}`);
  if (input.totalTracks != null) boosts.push(`tracks:${input.totalTracks}`);
  const year = extractYear(input.date);
  if (year != null) boosts.push(`date:${year}`);

  return [required.join(" AND "), ...boosts].join(" ").trim();
}

type RawTrack = { number?: string | null };
type RawMedium = { position?: number; "track-count"?: number; track?: RawTrack[] };
type RawRelease = {
  title?: string;
  date?: string;
  "release-group"?: { "primary-type"?: string };
  media?: RawMedium[];
};
type RawRecording = {
  id: string;
  score: number;
  title: string;
  length?: number | null;
  "artist-credit"?: { name: string }[];
  releases?: RawRelease[];
};

function mapRelease(r: RawRelease): MbReleaseCandidate {
  const medium = r.media?.[0];
  // Vinyl releases number tracks "A3"/"B1" rather than plainly — Number()
  // on those is NaN, not a real track number.
  const rawTrackNo = medium?.track?.[0]?.number;
  const parsedTrackNo = rawTrackNo != null ? Number(rawTrackNo) : null;
  return {
    title: r.title ?? null,
    releaseType: r["release-group"]?.["primary-type"] ?? null,
    date: r.date ?? null,
    trackCount: medium?.["track-count"] ?? null,
    trackNo: parsedTrackNo != null && !Number.isNaN(parsedTrackNo) ? parsedTrackNo : null,
  };
}

export async function searchRecording(input: RecordingSearchInput): Promise<MbRecordingCandidate[]> {
  await throttle();

  const query = buildRecordingQuery(input);
  const url = `${API_ROOT}/recording?query=${encodeURIComponent(query)}&fmt=json&limit=15`;

  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`MusicBrainz search failed: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as { recordings?: RawRecording[] };

  return (data.recordings ?? []).map((r) => ({
    mbid: r.id,
    score: r.score,
    title: r.title,
    artist: r["artist-credit"]?.[0]?.name ?? null,
    durationMs: r.length ?? null,
    releases: (r.releases ?? []).map(mapRelease),
  }));
}

// Cover Art Archive keys images by release (or release-group), never by
// recording — a matched recording (from searchRecording, above) only gives
// this server the one MBID that's actually of any use to CAA: this second
// lookup resolves it to the release-group its first known release belongs
// to. Only called once a recording has already matched (enrich/worker.ts),
// so throttling shares the same 1req/sec budget as the search that got us
// here.
export async function lookupReleaseGroupForRecording(mbid: string): Promise<string | null> {
  await throttle();

  const url = `${API_ROOT}/recording/${mbid}?inc=releases+release-groups&fmt=json`;
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`MusicBrainz recording lookup failed: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as { releases?: { "release-group"?: { id: string } }[] };
  return data.releases?.[0]?.["release-group"]?.id ?? null;
}
