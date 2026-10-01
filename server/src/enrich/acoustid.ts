// M-9: tier 2 of collapse matching — AcoustID resolves a
// Chromaprint fingerprint (match/fingerprint.ts computes it locally, no
// key needed for that half) to a MusicBrainz recording id via AcoustID's
// web service. That half genuinely needs a client key, the same way any
// AcoustID-consuming app does (Picard included) — registering one is an
// account Daniel has to create at https://acoustid.org/api-key, not
// something this session can obtain or fabricate. Missing key degrades the
// same way match/fingerprint.ts already degrades on a missing fpcalc
// binary: a warning logged once, the feature quietly inactive, nothing
// crashes.
//
// UNVERIFIED AGAINST THE LIVE SERVICE: this machine has neither fpcalc
// installed nor a key configured, so the request/response shape below is
// built from AcoustID's documented webservice contract
// (https://acoustid.org/webservice), not confirmed live the way every
// MusicBrainz-facing module in this codebase was. Treat the parsing logic
// as reviewed-not-proven until it's exercised against a real response.

const API_ROOT = "https://api.acoustid.org/v2/lookup";

const MIN_INTERVAL_MS = 350; // AcoustID's documented courtesy limit is ~3req/s per client
let lastRequestAt = 0;

async function throttle(): Promise<void> {
  const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();
}

let missingKeyWarned = false;

export type AcoustidMatch = { recordingMbid: string; score: number };

type RawRecording = { id: string };
type RawResult = { id: string; score: number; recordings?: RawRecording[] };
type RawLookupResponse = { status: string; results?: RawResult[] };

// Pure, so the flattening/sorting is unit-testable without a network call:
// one AcoustID "result" (a distinct acoustic fingerprint cluster, its own
// score) can map to several MusicBrainz recordings (different masters/
// pressings that happen to sound identical) — flattened here into one
// list, each recording inheriting its parent result's score, sorted best
// first the same way textSearch.ts's candidates are.
export function parseLookupResponse(data: RawLookupResponse): AcoustidMatch[] {
  const matches: AcoustidMatch[] = [];
  for (const result of data.results ?? []) {
    for (const recording of result.recordings ?? []) {
      matches.push({ recordingMbid: recording.id, score: result.score });
    }
  }
  return matches.sort((a, b) => b.score - a.score);
}

export async function lookupFingerprint(
  apiKey: string | undefined,
  fingerprint: string,
  durationSeconds: number,
): Promise<AcoustidMatch[]> {
  if (!apiKey) {
    if (!missingKeyWarned) {
      missingKeyWarned = true;
      console.warn(
        "[acoustid] ACOUSTID_API_KEY not set — tier 2 (fingerprint) fallback matching is disabled. " +
          "Get a free client key at https://acoustid.org/api-key and set it in server/.env.local to enable it.",
      );
    }
    return [];
  }

  await throttle();

  const url = `${API_ROOT}?client=${encodeURIComponent(apiKey)}&meta=recordings&duration=${Math.round(
    durationSeconds,
  )}&fingerprint=${encodeURIComponent(fingerprint)}&format=json`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`AcoustID lookup failed: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as RawLookupResponse;
  if (data.status !== "ok") return [];
  return parseLookupResponse(data);
}
