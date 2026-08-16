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

// M-6: release ("album-first") search input and results — a completely
// separate query shape from RecordingSearchInput above, searching MB's
// /release endpoint instead of /recording.
export type ReleaseSearchInput = {
  album: string;
  albumartist?: string | null;
  totalTracks?: number | null;
  date?: string | null;
};

export type MbReleaseCandidateSearch = {
  mbid: string;
  score: number;
  title: string;
  artist: string | null;
  releaseType: string | null;
  date: string | null;
  totalTracks: number | null;
};

// release+artist required; tracks/date left as bare boost terms for the
// same reason as buildRecordingQuery above — a required date can exclude
// the very edition that's otherwise the best match.
export function buildReleaseQuery(input: ReleaseSearchInput): string {
  const required = [`release:"${escapeLucene(input.album)}"`];
  if (input.albumartist) required.push(`artist:"${escapeLucene(input.albumartist)}"`);

  const boosts: string[] = [];
  if (input.totalTracks != null) boosts.push(`tracks:${input.totalTracks}`);
  const year = extractYear(input.date);
  if (year != null) boosts.push(`date:${year}`);

  return [required.join(" AND "), ...boosts].join(" ").trim();
}

type RawReleaseSearchResult = {
  id: string;
  score: number;
  title: string;
  date?: string;
  "track-count"?: number;
  "artist-credit"?: { name: string }[];
  "release-group"?: { "primary-type"?: string };
};

export async function searchRelease(input: ReleaseSearchInput): Promise<MbReleaseCandidateSearch[]> {
  await throttle();

  const query = buildReleaseQuery(input);
  const url = `${API_ROOT}/release?query=${encodeURIComponent(query)}&fmt=json&limit=15`;

  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`MusicBrainz release search failed: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as { releases?: RawReleaseSearchResult[] };

  return (data.releases ?? []).map((r) => ({
    mbid: r.id,
    score: r.score,
    title: r.title,
    artist: r["artist-credit"]?.[0]?.name ?? null,
    releaseType: r["release-group"]?.["primary-type"] ?? null,
    date: r.date ?? null,
    totalTracks: r["track-count"] ?? null,
  }));
}

// M-8: an artist relation attached to a recording — producer, engineer,
// mix, mastering, conductor, arranger, remixer, DJ-mixer are typically bare
// (attributes: []); vocal/instrument/performer relations carry the actual
// instrument or vocal part in attributes (["electric guitar"]), which is
// what a bare "performer" credit can't express on its own.
export type MbCredit = { type: string; artistName: string; attributes: string[] };

export type MbReleaseTrack = {
  position: number;
  recordingMbid: string;
  durationMs: number | null;
  isrc: string | null;
  credits: MbCredit[];
};

export type MbReleaseDetail = {
  mbid: string;
  status: string | null;
  country: string | null;
  barcode: string | null;
  asin: string | null;
  disambiguation: string | null;
  language: string | null;
  script: string | null;
  format: string | null;
  releaseGroupMbid: string | null;
  firstReleaseDate: string | null;
  labelName: string | null;
  catalogNumber: string | null;
  tracks: MbReleaseTrack[];
};

type RawArtistRel = {
  type: string;
  "target-type": string;
  artist?: { name: string };
  attributes?: string[];
};
type RawDetailTrack = {
  position: number;
  length?: number | null;
  recording?: { id: string; length?: number | null; isrcs?: string[]; relations?: RawArtistRel[] };
};
type RawDetailMedium = { format?: string | null; tracks?: RawDetailTrack[] };
type RawLabelInfo = { "catalog-number"?: string | null; label?: { name?: string | null } };
type RawReleaseGroup = { id?: string; "first-release-date"?: string | null };
export type RawReleaseDetail = {
  id: string;
  status?: string | null;
  country?: string | null;
  barcode?: string | null;
  asin?: string | null;
  disambiguation?: string | null;
  "text-representation"?: { language?: string | null; script?: string | null };
  "release-group"?: RawReleaseGroup;
  "label-info"?: RawLabelInfo[];
  media?: RawDetailMedium[];
};

// Pure parsing, split out from the fetch so M-8's field mapping is
// unit-testable against a captured real response (no network, no
// database) rather than only exercised live. Real shape confirmed against
// a live GET /release/{mbid}?inc=...recording-level-rels+artist-rels+isrcs
// while building this (a Beatles "Abbey Road" release): recording.relations[]
// carries type/artist/attributes, recording.isrcs[] sits alongside it, and
// label-info[]/release-group/text-representation are exactly the shape
// used below.
export function parseReleaseDetail(data: RawReleaseDetail): MbReleaseDetail {
  const tracks: MbReleaseTrack[] = [];
  for (const medium of data.media ?? []) {
    for (const t of medium.tracks ?? []) {
      const recordingMbid = t.recording?.id;
      if (recordingMbid == null) continue;
      const credits: MbCredit[] = (t.recording?.relations ?? [])
        .filter((r) => r["target-type"] === "artist" && r.artist?.name)
        .map((r) => ({ type: r.type, artistName: r.artist!.name, attributes: r.attributes ?? [] }));
      tracks.push({
        position: t.position,
        // The track's own length can differ slightly from the recording's
        // canonical length (a different edit/fade) — the track length is
        // what actually played on *this* release, so it wins when both exist.
        durationMs: t.length ?? t.recording?.length ?? null,
        recordingMbid,
        isrc: t.recording?.isrcs?.[0] ?? null,
        credits,
      });
    }
  }

  const labelInfo = data["label-info"]?.[0];

  return {
    mbid: data.id,
    status: data.status ?? null,
    country: data.country ?? null,
    barcode: data.barcode ?? null,
    asin: data.asin ?? null,
    disambiguation: data.disambiguation || null,
    language: data["text-representation"]?.language ?? null,
    script: data["text-representation"]?.script ?? null,
    format: data.media?.[0]?.format ?? null,
    releaseGroupMbid: data["release-group"]?.id ?? null,
    firstReleaseDate: data["release-group"]?.["first-release-date"] ?? null,
    labelName: labelInfo?.label?.name ?? null,
    catalogNumber: labelInfo?.["catalog-number"] ?? null,
    tracks,
  };
}

// inc=recordings+artist-credits+labels+release-groups is the one request
// that replaces N per-recording lookups — every track's real recording
// MBID comes back in a single call. recording-level-rels+artist-rels+isrcs
// are M-8's wider field harvest, fetched in this same request rather than
// a second one per album.
export async function fetchReleaseDetail(mbid: string): Promise<MbReleaseDetail | null> {
  await throttle();

  const url = `${API_ROOT}/release/${mbid}?inc=recordings+artist-credits+labels+release-groups+recording-level-rels+artist-rels+isrcs&fmt=json`;
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`MusicBrainz release lookup failed: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as RawReleaseDetail;
  return parseReleaseDetail(data);
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
