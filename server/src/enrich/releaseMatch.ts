import type { MbReleaseCandidateSearch, MbReleaseDetail, MbReleaseTrack } from "./mbClient.js";
import { similarity2 } from "./textSearch.js";

// M-6: Legato issued one independent lookup per recording — for a real
// unmatched album in this library (Blonde on Blonde), that was 14
// separate rate-limited requests, 14 independent ambiguous flags, and no
// use of the one piece of context that would have resolved all of them
// at once: track order within a specific release. Picard matches
// per-release for exactly this reason — search once, fetch the full
// tracklist, assign every local file by position.
//
// Cluster weights are Picard's own (picard/cluster.py) — album carries
// the heaviest weight here (unlike textSearch.ts's recording-level
// weights, where releasetype dominates), since a release search is
// fundamentally "find the album", not "find the recording."
const CLUSTER_WEIGHTS = {
  album: 17,
  albumartist: 6,
  totaltracks: 5,
  releasetype: 10,
  date: 4,
} as const;
const CLUSTER_TOTAL_WEIGHT = Object.values(CLUSTER_WEIGHTS).reduce((a, b) => a + b, 0);

// Same shape of decision as textSearch.ts's MIN_CONFIDENCE, tuned
// separately since the two scorers weigh completely different fields —
// no reason to assume the same cutoff means the same thing on both.
const MIN_RELEASE_CONFIDENCE = 0.35;

export type LocalAlbumInput = {
  album: string;
  albumartist: string | null;
  totalTracks: number | null;
  releaseType: string | null;
  date: string | null;
};

const RELEASE_TYPE_PREFERENCE: Record<string, number> = {
  album: 1,
  ep: 0.7,
  single: 0.7,
};

function releaseTypeScore(local: string | null, candidate: string | null): number {
  if (local && candidate) return similarity2(local, candidate);
  if (!candidate) return 0.3;
  return RELEASE_TYPE_PREFERENCE[candidate.toLowerCase()] ?? 0.3;
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

function dateScore(local: string | null, candidate: string | null): number {
  const localYear = yearOf(local);
  const candidateYear = yearOf(candidate);
  if (localYear == null || candidateYear == null) return 0.5;
  const diff = Math.abs(localYear - candidateYear);
  if (diff === 0) return 1;
  if (diff === 1) return 0.5;
  return 0;
}

// Exported for M-5's future candidate picker, same reasoning as
// textSearch.ts's scoreCandidate.
export function scoreReleaseCandidate(local: LocalAlbumInput, candidate: MbReleaseCandidateSearch): number {
  const parts = {
    album: similarity2(local.album, candidate.title),
    albumartist: similarity2(local.albumartist, candidate.artist),
    totaltracks: totalTracksScore(local.totalTracks, candidate.totalTracks),
    releasetype: releaseTypeScore(local.releaseType, candidate.releaseType),
    date: dateScore(local.date, candidate.date),
  };
  const weighted =
    (CLUSTER_WEIGHTS.album * parts.album +
      CLUSTER_WEIGHTS.albumartist * parts.albumartist +
      CLUSTER_WEIGHTS.totaltracks * parts.totaltracks +
      CLUSTER_WEIGHTS.releasetype * parts.releasetype +
      CLUSTER_WEIGHTS.date * parts.date) /
    CLUSTER_TOTAL_WEIGHT;

  return weighted * (candidate.score / 100);
}

// null when nothing clears the confidence floor — the caller falls back
// to per-recording search rather than committing to a weak release guess.
export function pickBestRelease(
  local: LocalAlbumInput,
  candidates: MbReleaseCandidateSearch[],
): MbReleaseCandidateSearch | null {
  if (candidates.length === 0) return null;
  const scored = candidates
    .map((c) => ({ candidate: c, score: scoreReleaseCandidate(local, c) }))
    .sort((a, b) => b.score - a.score);
  return scored[0].score >= MIN_RELEASE_CONFIDENCE ? scored[0].candidate : null;
}

export type LocalTrack = {
  fileId: number;
  trackNo: number | null;
  discNo: number | null;
  durationMs: number | null;
};

export type TrackAssignment = { fileId: number; recordingMbid: string };

// Assigns each local file to a recording MBID from the fetched release —
// by track position first (the reliable signal once the right release is
// already chosen), falling back to closest duration among the tracks not
// already claimed when a file has no track number or its number doesn't
// appear on this release (a bonus/hidden track, a mismatched edition).
// Never assigns the same release track twice.
//
// Position matching is disc-aware, and has to be. MusicBrainz numbers each
// medium from 1, so a two-disc release has two track 1s, two track 2s, and
// so on. Keying a lookup on the bare position silently lets the last disc
// overwrite every earlier one, which is not a near-miss: on Blonde on
// Blonde (8 + 6) it handed the first six local tracks the MBIDs of six
// completely different songs off disc two, and left the real disc-two
// tracks to the duration fallback, where they collided with recordings
// already claimed and merged unrelated songs onto shared nodes.
//
// Two shapes of tagging have to work, so both keys are built:
//   disc+track   files tagged with a real disc number, matched (2, 1)
//   absolute     files numbered straight through 1..14 with no disc number
//                (or with every track claiming disc 1), which is how a
//                double LP ripped into a single folder usually looks —
//                exactly the case above
// Disc+track is tried first and absolute catches what it misses, so a file
// insisting it is disc 1 track 9 of an 8-track disc still lands on disc 2
// track 1 rather than falling through to a duration guess.
export function assignTracks(
  localFiles: LocalTrack[],
  release: MbReleaseDetail,
  alreadyUsedMbids: ReadonlySet<string> = new Set(),
): TrackAssignment[] {
  const claimed = new Set<number>(); // absolutePosition — unique release-wide, unlike position
  const assignments: TrackAssignment[] = [];

  // Recordings already assigned to other files of this same release, on an
  // earlier run. tryAlbumMatch only ever sees the files still unmatched, so
  // without this the duration fallback happily re-hands a recording that a
  // previous pass already gave to a different track — and applyMatch then
  // reads that as "these two files are the same recording" and merges two
  // unrelated songs onto one node. Two different tracks of one release are
  // never the same recording, so claiming them up front is simply true.
  for (const track of release.tracks) {
    if (alreadyUsedMbids.has(track.recordingMbid)) claimed.add(track.absolutePosition);
  }

  const byDiscAndTrack = new Map<string, MbReleaseTrack>();
  const byAbsolute = new Map<number, MbReleaseTrack>();
  for (const track of release.tracks) {
    // First writer wins on both maps: a malformed release listing the same
    // slot twice should not have the later copy silently displace the
    // earlier, which is the exact failure this function is fixing.
    const discKey = `${track.mediumPosition}:${track.position}`;
    if (!byDiscAndTrack.has(discKey)) byDiscAndTrack.set(discKey, track);
    if (!byAbsolute.has(track.absolutePosition)) byAbsolute.set(track.absolutePosition, track);
  }

  const locateByPosition = (file: LocalTrack): MbReleaseTrack | undefined => {
    if (file.trackNo == null) return undefined;
    if (file.discNo != null) {
      const onDisc = byDiscAndTrack.get(`${file.discNo}:${file.trackNo}`);
      if (onDisc) return onDisc;
    }
    return byAbsolute.get(file.trackNo);
  };

  const unresolved: LocalTrack[] = [];
  for (const file of localFiles) {
    const track = locateByPosition(file);
    if (track && !claimed.has(track.absolutePosition)) {
      claimed.add(track.absolutePosition);
      assignments.push({ fileId: file.fileId, recordingMbid: track.recordingMbid });
    } else {
      unresolved.push(file);
    }
  }

  for (const file of unresolved) {
    if (file.durationMs == null) continue;
    let best: MbReleaseTrack | undefined;
    let bestDiff = Infinity;
    for (const track of release.tracks) {
      if (claimed.has(track.absolutePosition) || track.durationMs == null) continue;
      const diff = Math.abs(track.durationMs - file.durationMs);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = track;
      }
    }
    if (best) {
      claimed.add(best.absolutePosition);
      assignments.push({ fileId: file.fileId, recordingMbid: best.recordingMbid });
    }
  }

  return assignments;
}
