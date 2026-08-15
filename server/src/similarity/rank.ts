import { cosineSimilarity } from "./features.js";

export type Candidate = { nodeId: number; vector: number[] };
export type RankedResult = { nodeId: number; score: number };

export function rankMostSimilar(anchor: number[], candidates: Candidate[], count: number): RankedResult[] {
  return candidates
    .map((c) => ({ nodeId: c.nodeId, score: cosineSimilarity(anchor, c.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, count);
}

// "Completely different" isn't just the single furthest node — the purely
// furthest candidate is routinely a weird one-off (an interlude, a spoken-
// word intro, a lone genre outlier), which reads as a bug ("why did it pick
// *that*?") rather than a real contrast. Biased toward well-populated
// regions instead: take a wider pool of the furthest candidates, then
// within that pool prefer whichever have the most company of their own —
// candidates that are themselves similar to a lot of *other* tracks, not
// lone outliers.
const COVERAGE_SIMILARITY_THRESHOLD = 0.5;
const POOL_MULTIPLIER = 4;

export function rankMostDissimilar(anchor: number[], candidates: Candidate[], count: number): RankedResult[] {
  if (candidates.length === 0) return [];

  const distances = candidates
    .map((c) => ({ nodeId: c.nodeId, vector: c.vector, distance: 1 - cosineSimilarity(anchor, c.vector) }))
    .sort((a, b) => b.distance - a.distance);

  const poolSize = Math.min(distances.length, Math.max(count * POOL_MULTIPLIER, count));
  const pool = distances.slice(0, poolSize);

  const coverage = (vector: number[]): number =>
    candidates.reduce((n, c) => (cosineSimilarity(vector, c.vector) >= COVERAGE_SIMILARITY_THRESHOLD ? n + 1 : n), 0);

  return pool
    .map((p) => ({ nodeId: p.nodeId, score: 1 - cosineSimilarity(anchor, p.vector), coverage: coverage(p.vector) }))
    .sort((a, b) => b.coverage - a.coverage || b.score - a.score)
    .slice(0, count)
    .map(({ nodeId, score }) => ({ nodeId, score }));
}
