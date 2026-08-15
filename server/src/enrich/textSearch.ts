import type { MbRecordingCandidate, MbReleaseCandidate } from "./mbClient.js";

// M-3: MusicBrainz's `score` is text relevance, not a match confidence —
// it saturates at 100 for any common title by a famous artist, which is
// exactly when it carries the least information (a real case from this
// library: "Visions of Johanna"/Bob Dylan returns 15 candidates all
// scored 100). Picard never ranks by that score alone; it computes its
// own weighted similarity across every field it has and uses MB's score
// only to scale the result (picard/file.py, picard/cluster.py):
//
//   sim = linear_combination_of_weights(parts) * get_score(node)
//
// Weights below are Picard's own, ported as-is. The heavy weight on
// releasetype is the load-bearing one: it's what makes a studio album
// outrank a live bootleg or a compilation carrying the identical title,
// artist and near-identical duration.
const FIELD_WEIGHTS = {
  releasetype: 14,
  title: 13,
  length: 10,
  album: 5,
  artist: 4,
  totaltracks: 4,
  date: 4,
} as const;
const TOTAL_WEIGHT = Object.values(FIELD_WEIGHTS).reduce((a, b) => a + b, 0);

const MIN_SCORE = 50; // a relevance floor, not a confidence threshold — see below

// Candidates whose final weighted*scaled score lands within this of the
// top one are treated as tied. Deliberately tiny, not a generic
// "percentage point" tolerance — length carries weight 10 of 54 total, so
// even the full 30-second range M-4's gradient spans only ever moves the
// final score by (10/54) ~= 0.185 at most, and the real case this was
// tuned against (three candidates 7ms/54ms/572ms from the local file)
// only separates by ~0.0003-0.0035. An epsilon anywhere near a "round"
// value like 0.01 would swallow exactly the signal M-4 exists to
// provide, and this system would degrade back into M-3's problem: the
// bulk of the score's dynamic range comes from a handful of fields that
// are 0/1 or 0/0.5/1, so genuinely distinct candidates rarely land
// closer together than this — the "Come Together" 5-way tie below (every
// field identical, nothing to discriminate on) still lands at an exact
// zero difference and stays ambiguous regardless of how tight this is.
const TIE_EPSILON = 0.0002;
const MIN_CONFIDENCE = 0.35;

export type LocalMatchInput = {
  title: string;
  artist: string;
  album: string | null;
  trackNo: number | null;
  totalTracks: number | null;
  date: string | null;
  durationMs: number | null;
};

export type MatchResult =
  | { outcome: "matched"; mbid: string; confidence: number }
  | { outcome: "ambiguous"; candidates: MbRecordingCandidate[] }
  | { outcome: "no_match" };

function normalizeWords(s: string): string[] {
  return s
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

// Picard's similarity2 — word-wise comparison rather than exact string
// equality, so "Blonde On Blonde" and "Blonde on Blonde" (a real
// case: casing drift between a local tag and MB's title) score as the
// same album instead of merely "close." Dice coefficient over word
// multisets: 1.0 for an identical bag of words, 0 for no overlap.
export function similarity2(a: string | null, b: string | null): number {
  if (!a || !b) return 0;
  const wordsA = normalizeWords(a);
  const wordsB = normalizeWords(b);
  if (wordsA.length === 0 || wordsB.length === 0) return 0;

  const remaining = new Map<string, number>();
  for (const w of wordsB) remaining.set(w, (remaining.get(w) ?? 0) + 1);
  let common = 0;
  for (const w of wordsA) {
    const count = remaining.get(w) ?? 0;
    if (count > 0) {
      common++;
      remaining.set(w, count - 1);
    }
  }
  return (2 * common) / (wordsA.length + wordsB.length);
}

// M-4: length_score(a, b) = 1 - min(|a-b|, 30000) / 30000 — Picard's own
// formula. Replaces a hard ±3000ms gate that could only ever narrow a
// tie to zero or "still tied"; a continuous gradient separates
// candidates a boolean filter couldn't. No duration on either side is
// neutral (0.5), not a penalty — plenty of real MB candidates carry no
// length at all, and that absence isn't evidence against the candidate.
export function lengthScore(localMs: number | null, candidateMs: number | null): number {
  if (localMs == null || candidateMs == null) return 0.5;
  return 1 - Math.min(Math.abs(localMs - candidateMs), 30000) / 30000;
}

const RELEASE_TYPE_PREFERENCE: Record<string, number> = {
  album: 1,
  ep: 0.7,
  single: 0.7,
};

// Compares against a local releaseType tag when one exists. Most files in
// a real library never carry one (the tag is populated by enrichment
// itself, not read locally in advance), so this falls back to Picard's
// implicit preference — a studio album outranks a live recording or a
// compilation even with nothing local to compare it to, which is the
// actual behavior the heavy releasetype weight exists to produce.
function releaseTypeScore(localReleaseType: string | null, candidateType: string | null): number {
  if (localReleaseType && candidateType) return similarity2(localReleaseType, candidateType);
  if (!candidateType) return 0.3;
  return RELEASE_TYPE_PREFERENCE[candidateType.toLowerCase()] ?? 0.3;
}

function totalTracksScore(local: number | null, candidate: number | null): number {
  if (local == null || candidate == null) return 0.5;
  return local === candidate ? 1 : 0;
}

function yearOf(dateStr: string | null): number | null {
  if (!dateStr) return null;
  const match = /^(\d{4})/.exec(dateStr);
  return match ? Number(match[1]) : null;
}

function dateScore(localDate: string | null, candidateDate: string | null): number {
  const localYear = yearOf(localDate);
  const candidateYear = yearOf(candidateDate);
  if (localYear == null || candidateYear == null) return 0.5;
  const diff = Math.abs(localYear - candidateYear);
  if (diff === 0) return 1;
  if (diff === 1) return 0.5;
  return 0;
}

// A recording can appear on several releases (a studio LP, a live
// bootleg, a box set reissue...) — score against each and take the best,
// the same way Picard weighs every release a recording belongs to
// instead of picking one arbitrarily.
function bestReleaseFields(
  local: LocalMatchInput,
  releases: MbReleaseCandidate[],
): { album: number; releasetype: number; totaltracks: number; date: number } {
  if (releases.length === 0) {
    return { album: local.album ? 0 : 0.5, releasetype: releaseTypeScore(null, null), totaltracks: 0.5, date: 0.5 };
  }
  let best = { album: -1, releasetype: 0, totaltracks: 0, date: 0 };
  let bestSum = -1;
  for (const release of releases) {
    const fields = {
      album: local.album ? similarity2(local.album, release.title) : 0.5,
      releasetype: releaseTypeScore(null, release.releaseType),
      totaltracks: totalTracksScore(local.totalTracks, release.trackCount),
      date: dateScore(local.date, release.date),
    };
    const sum = fields.album + fields.releasetype + fields.totaltracks + fields.date;
    if (sum > bestSum) {
      bestSum = sum;
      best = fields;
    }
  }
  return best;
}

// The weighted, MB-score-scaled similarity a real match decision is based
// on — 0 to 1. Exported for the maintenance-view candidate picker (M-5),
// which needs to show the same per-candidate score it ranked against.
export function scoreCandidate(local: LocalMatchInput, candidate: MbRecordingCandidate): number {
  const releaseFields = bestReleaseFields(local, candidate.releases);
  const parts = {
    title: similarity2(local.title, candidate.title),
    artist: similarity2(local.artist, candidate.artist),
    length: lengthScore(local.durationMs, candidate.durationMs),
    ...releaseFields,
  };
  const weighted =
    (FIELD_WEIGHTS.title * parts.title +
      FIELD_WEIGHTS.artist * parts.artist +
      FIELD_WEIGHTS.length * parts.length +
      FIELD_WEIGHTS.album * parts.album +
      FIELD_WEIGHTS.releasetype * parts.releasetype +
      FIELD_WEIGHTS.totaltracks * parts.totaltracks +
      FIELD_WEIGHTS.date * parts.date) /
    TOTAL_WEIGHT;

  return weighted * (candidate.score / 100);
}

// Falls through to "ambiguous" on a wide tie by default — not just when
// there are zero results — per the actual failure mode observed against
// MusicBrainz: a real, ordinary title returning many perfectly-tied
// candidates is common, not an edge case. MIN_SCORE here is a relevance
// floor (MB found this vaguely plausible at all), not a confidence
// threshold — that job now belongs to MIN_CONFIDENCE on the weighted
// score, since MB's own score no longer decides the ranking.
export function pickBestMatch(candidates: MbRecordingCandidate[], local: LocalMatchInput): MatchResult {
  const relevant = candidates.filter((c) => c.score >= MIN_SCORE);
  if (relevant.length === 0) return { outcome: "no_match" };

  // De-dupe by mbid, keeping the higher-scored occurrence — the same
  // recording can appear more than once in a search response.
  const byMbid = new Map<string, MbRecordingCandidate>();
  for (const c of relevant) {
    const existing = byMbid.get(c.mbid);
    if (!existing || c.score > existing.score) byMbid.set(c.mbid, c);
  }
  const distinct = [...byMbid.values()];

  const scored = distinct
    .map((c) => ({ candidate: c, score: scoreCandidate(local, c) }))
    .sort((a, b) => b.score - a.score);

  const topScore = scored[0].score;
  if (topScore < MIN_CONFIDENCE) return { outcome: "no_match" };

  const tied = scored.filter((s) => topScore - s.score <= TIE_EPSILON);
  if (tied.length > 1) {
    return { outcome: "ambiguous", candidates: tied.map((t) => t.candidate) };
  }

  return { outcome: "matched", mbid: scored[0].candidate.mbid, confidence: topScore };
}
