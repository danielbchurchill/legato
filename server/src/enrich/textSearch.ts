import type { MbRecordingCandidate } from "./mbClient.js";

const MIN_SCORE = 80;
const DURATION_TOLERANCE_MS = 3000;
// Real MusicBrainz data confirms this isn't hypothetical: searching
// "Come Together" / "The Beatles" with no duration hint returns 5+ distinct
// recording MBIDs all scored 100 — a wide tie at the top, not a clean
// winner. Candidates within this many points of the top score count as tied.
const WIDE_TIE_EPSILON = 2;

export type MatchResult =
  | { outcome: "matched"; mbid: string; confidence: number }
  | { outcome: "ambiguous"; candidates: MbRecordingCandidate[] }
  | { outcome: "no_match" };

// Falls through to "ambiguous" on a wide tie by default — not just when
// there are zero results — per the actual failure mode observed against
// MusicBrainz: a real, ordinary title returning many perfectly-tied
// candidates is common, not an edge case.
export function pickBestMatch(candidates: MbRecordingCandidate[], localDurationMs: number | null): MatchResult {
  const scored = candidates.filter((c) => c.score >= MIN_SCORE);
  if (scored.length === 0) return { outcome: "no_match" };

  const durationMatched = localDurationMs != null
    ? scored.filter((c) => c.durationMs != null && Math.abs(c.durationMs - localDurationMs) <= DURATION_TOLERANCE_MS)
    : [];
  const pool = durationMatched.length > 0 ? durationMatched : scored;

  const topScore = Math.max(...pool.map((c) => c.score));
  const tied = pool.filter((c) => topScore - c.score <= WIDE_TIE_EPSILON);
  // De-dupe by mbid, keeping the higher-scored occurrence — the same
  // recording can appear more than once in a search response.
  const byMbid = new Map<string, MbRecordingCandidate>();
  for (const c of tied) {
    const existing = byMbid.get(c.mbid);
    if (!existing || c.score > existing.score) byMbid.set(c.mbid, c);
  }
  const distinctTied = [...byMbid.values()];

  if (distinctTied.length > 1) {
    return { outcome: "ambiguous", candidates: distinctTied };
  }

  return { outcome: "matched", mbid: distinctTied[0].mbid, confidence: distinctTied[0].score / 100 };
}
