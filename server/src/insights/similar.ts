import type { Database } from "../sqlite.js";
import { WEIGHTS } from "../similarity/features.js";
import type { LibraryEdges } from "./links.js";

/* #468's "Sounds alike": artists the similarity features put close together.
 *
 * The similarity vectors (similarity/features.ts) are per recording and per
 * album, dense, and as long as the library's vocabulary: thousands of
 * numbers each at 30,000 albums, which is why GET /nodes/:id/similar takes
 * 24-33 s there (#382). Comparing every pair of artists that way is out of
 * reach. So each artist gets a profile built from the same feature groups
 * with the same weights, kept sparse: its tracks' genres, labels and release
 * types as shares, and the mean of their decade, length and tempo, each
 * group scaled to unit length and weighted as features.ts weights it.
 *
 * Two groups are left out. The artist group is the artist's own identity,
 * the same for none of a pair. The artist-cluster group is made from
 * collaborated_with ties, which are connections, and this card is about
 * artists with none between them.
 *
 * A pair has to share a genre to count. Genre is the one feature that says
 * anything about how a record sounds, and a pair that shares only a decade
 * and a typical track length would come out identical without it. A library
 * with no genre tags has no "Sounds alike" card. */

/** How many neighbours each artist keeps. */
export const NEIGHBOURS = 5;
/** The lowest cosine a pair can have and still count as alike. */
export const MIN_SCORE = 0.6;

export type TrackFeatures = {
  artist: number;
  genres: string[];
  label: number | null;
  releaseType: string | null;
  year: number | null;
  durationMs: number | null;
  bpm: number | null;
};

export type SimilarArtist = { artist: number; other: number; score: number; shared: string[] };

type Profile = {
  artist: number;
  index: Int32Array;
  value: Float64Array;
  norm: number;
  genres: Map<string, number>;
  decade: number | null;
};

function shares<K>(counts: Map<K, number>): Map<K, number> {
  const norm = Math.hypot(...counts.values());
  return new Map([...counts].map(([key, count]) => [key, norm > 0 ? count / norm : 0]));
}

function mean(values: number[]): number | null {
  return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function range(values: (number | null)[]): [number, number] {
  const present = values.filter((v): v is number => v != null);
  return present.length > 0 ? [Math.min(...present), Math.max(...present)] : [0, 0];
}

// The same mapping as features.ts's scaledScalar: [-1, 1] across the range.
function scaled(value: number | null, [min, max]: [number, number]): number {
  if (value == null || max === min) return 0;
  return ((value - min) / (max - min)) * 2 - 1;
}

export function buildProfiles(tracks: TrackFeatures[]): Profile[] {
  type Gathered = {
    genres: Map<string, number>;
    labels: Map<number, number>;
    types: Map<string, number>;
    years: number[];
    durations: number[];
    bpms: number[];
  };
  const byArtist = new Map<number, Gathered>();
  for (const t of tracks) {
    let g = byArtist.get(t.artist);
    if (!g)
      byArtist.set(
        t.artist,
        (g = { genres: new Map(), labels: new Map(), types: new Map(), years: [], durations: [], bpms: [] }),
      );
    for (const genre of t.genres) g.genres.set(genre, (g.genres.get(genre) ?? 0) + 1);
    if (t.label != null) g.labels.set(t.label, (g.labels.get(t.label) ?? 0) + 1);
    if (t.releaseType != null) g.types.set(t.releaseType, (g.types.get(t.releaseType) ?? 0) + 1);
    if (t.year != null) g.years.push(t.year);
    if (t.durationMs != null) g.durations.push(t.durationMs);
    if (t.bpm != null) g.bpms.push(t.bpm);
  }

  const means = [...byArtist].map(([artist, g]) => ({
    artist,
    g,
    decade: mean(g.years.map((y) => Math.floor(y / 10) * 10)),
    duration: mean(g.durations),
    bpm: mean(g.bpms),
  }));
  const decadeRange = range(means.map((m) => m.decade));
  const durationRange = range(means.map((m) => m.duration));
  const bpmRange = range(means.map((m) => m.bpm));

  // Dimensions 0-2 are the scalars; every genre, label and release type
  // gets one after them as it's first seen.
  const dims = new Map<string, number>();
  const dim = (key: string) => {
    let d = dims.get(key);
    if (d == null) dims.set(key, (d = dims.size + 3));
    return d;
  };

  return means.map(({ artist, g, decade, duration, bpm }) => {
    const entries: [number, number][] = [];
    const scalar = (d: number, v: number) => v !== 0 && entries.push([d, v]);
    scalar(0, scaled(decade, decadeRange) * WEIGHTS.decade);
    scalar(1, scaled(duration, durationRange) * WEIGHTS.duration);
    scalar(2, scaled(bpm, bpmRange) * WEIGHTS.bpm);
    for (const [genre, share] of shares(g.genres)) entries.push([dim(`g:${genre}`), share * WEIGHTS.genre]);
    for (const [label, share] of shares(g.labels)) entries.push([dim(`l:${label}`), share * WEIGHTS.label]);
    for (const [type, share] of shares(g.types)) entries.push([dim(`t:${type}`), share * WEIGHTS.releaseType]);
    entries.sort((a, b) => a[0] - b[0]);
    const value = Float64Array.from(entries, ([, v]) => v);
    // The decade most of its tracks are from, for "both 1970s".
    const decades = new Map<number, number>();
    for (const y of g.years) decades.set(Math.floor(y / 10) * 10, (decades.get(Math.floor(y / 10) * 10) ?? 0) + 1);
    const topDecade = [...decades].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? null;
    return {
      artist,
      index: Int32Array.from(entries, ([d]) => d),
      value,
      norm: Math.hypot(...value),
      genres: g.genres,
      decade: topDecade,
    };
  });
}

function cosine(a: Profile, b: Profile): number {
  if (a.norm === 0 || b.norm === 0) return 0;
  let dot = 0;
  let i = 0;
  let j = 0;
  while (i < a.index.length && j < b.index.length) {
    const da = a.index[i]!;
    const db = b.index[j]!;
    if (da === db) dot += a.value[i++]! * b.value[j++]!;
    else if (da < db) i++;
    else j++;
  }
  return dot / (a.norm * b.norm);
}

/** What a pair has in common, in words: up to two genres, most shared
 *  first, and the decade if most of both's tracks are from the same one. */
function sharedWords(a: Profile, b: Profile): string[] {
  const genres = [...a.genres.keys()]
    .filter((genre) => b.genres.has(genre))
    .sort(
      (x, y) =>
        Math.min(b.genres.get(y)!, a.genres.get(y)!) - Math.min(b.genres.get(x)!, a.genres.get(x)!) ||
        x.localeCompare(y),
    )
    .slice(0, 2);
  return a.decade != null && a.decade === b.decade ? [...genres, `${a.decade}s`] : genres;
}

/** Each artist's closest NEIGHBOURS among those sharing a genre with it,
 *  at MIN_SCORE or more. A pair close to each other comes out twice, once
 *  each way. */
export function computeSimilarArtists(tracks: TrackFeatures[]): SimilarArtist[] {
  const profiles = buildProfiles(tracks);
  const byGenre = new Map<string, number[]>();
  profiles.forEach((p, i) => {
    for (const genre of p.genres.keys()) {
      const list = byGenre.get(genre) ?? [];
      list.push(i);
      byGenre.set(genre, list);
    }
  });

  const best: { other: number; score: number }[][] = profiles.map(() => []);
  const keep = (i: number, other: number, score: number) => {
    const list = best[i]!;
    if (list.length === NEIGHBOURS && score <= list[NEIGHBOURS - 1]!.score) return;
    list.push({ other, score });
    list.sort((x, y) => y.score - x.score || profiles[x.other]!.artist - profiles[y.other]!.artist);
    if (list.length > NEIGHBOURS) list.pop();
  };

  const seen = new Uint8Array(profiles.length);
  for (let i = 0; i < profiles.length; i++) {
    const candidates: number[] = [];
    for (const genre of profiles[i]!.genres.keys()) {
      for (const j of byGenre.get(genre)!) {
        if (j <= i || seen[j]) continue;
        seen[j] = 1;
        candidates.push(j);
      }
    }
    for (const j of candidates) {
      seen[j] = 0;
      const score = cosine(profiles[i]!, profiles[j]!);
      if (score < MIN_SCORE) continue;
      keep(i, j, score);
      keep(j, i, score);
    }
  }

  const out: SimilarArtist[] = [];
  best.forEach((list, i) => {
    const a = profiles[i]!;
    for (const { other, score } of list) {
      const b = profiles[other]!;
      out.push({ artist: a.artist, other: b.artist, score: Math.round(score * 1e4) / 1e4, shared: sharedWords(a, b) });
    }
  });
  return out;
}

/** The features of every track with a file by one of `yours`, filed under
 *  its first credited artist, as the similarity vectors file it. */
export function readTrackFeatures(db: Database, yours: Set<number>, edges: LibraryEdges): TrackFeatures[] {
  const label = new Map<number, number>();
  for (const [rec, l] of edges.labels) if (!label.has(rec)) label.set(rec, l);
  // One file per recording, the lowest id, as similarity.ts picks it.
  const rows = db
    .prepare(
      `SELECT f.recording_node_id, f.genre, f.release_type, f.duration_ms, f.bpm, MIN(f.id)
         FROM files f GROUP BY f.recording_node_id`,
    )
    .values() as [number, string | null, string | null, number | null, number | null][];
  const tracks: TrackFeatures[] = [];
  // Most of a library's tracks share a handful of genre tags, so each is
  // parsed once.
  const parsed = new Map<string, string[]>();
  const genresOf = (genre: string | null): string[] => {
    if (!genre) return [];
    let genres = parsed.get(genre);
    if (!genres) {
      try {
        genres = (JSON.parse(genre) as string[]).map((g) => String(g).trim().toLowerCase()).filter(Boolean);
      } catch {
        genres = [];
      }
      parsed.set(genre, genres);
    }
    return genres;
  };
  for (const [rec, genre, releaseType, durationMs, bpm] of rows) {
    const artist = edges.firstPerformer.get(rec);
    if (artist == null || !yours.has(artist)) continue;
    const genres = genresOf(genre);
    tracks.push({
      artist,
      genres,
      label: label.get(rec) ?? null,
      releaseType,
      year: edges.yearOf.get(rec) ?? null,
      durationMs,
      bpm,
    });
  }
  return tracks;
}
