import { countNear, Pacer, rowOf, scoreRows, type VectorIndex } from "./vectorIndex.js";

export type RankedResult = { nodeId: number; score: number };

/** Who's ranked: the rows of the anchor's type, but for the nodes in
 *  `leaveOut`. The anchor's own row is never one of them. */
export type CandidatePool = { index: VectorIndex; anchor: number; leaveOut: Iterable<number> };

/** The rows a ranking leaves out, as scoreRows and countNear take them:
 *  the anchor's and those of the pool's leaveOut nodes. */
function leaveOutMask(pool: CandidatePool): Uint8Array {
  const mask = new Uint8Array(pool.index.ids.length);
  mask[pool.anchor] = 1;
  for (const nodeId of pool.leaveOut) {
    const row = rowOf(pool.index, nodeId);
    if (row >= 0) mask[row] = 1;
  }
  return mask;
}

// The best `count` rows of `scores`, highest first, NaN (not a candidate)
// left out; with `distance`, the highest 1 - score. A row that ties one
// already kept goes after it, so ties keep row (node id) order, as a stable
// sort over every candidate did.
function best(scores: Float64Array, count: number, distance: boolean): { row: number; score: number }[] {
  const kept: { row: number; score: number }[] = [];
  if (count <= 0) return kept;
  for (let row = 0; row < scores.length; row++) {
    if (Number.isNaN(scores[row]!)) continue;
    const score = distance ? 1 - scores[row]! : scores[row]!;
    if (kept.length === count && !(score > kept[count - 1]!.score)) continue;
    let at = kept.length;
    while (at > 0 && score > kept[at - 1]!.score) at--;
    kept.splice(at, 0, { row, score });
    if (kept.length > count) kept.pop();
  }
  return kept;
}

export async function rankMostSimilar(pool: CandidatePool, count: number): Promise<RankedResult[]> {
  const { index, anchor } = pool;
  const scores = new Float64Array(index.ids.length);
  await scoreRows(index, anchor, index.kinds[anchor]!, leaveOutMask(pool), scores);
  return best(scores, count, false).map(({ row, score }) => ({ nodeId: index.ids[row]!, score }));
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

export async function rankMostDissimilar(pool: CandidatePool, count: number): Promise<RankedResult[]> {
  const { index, anchor } = pool;
  const kind = index.kinds[anchor]!;
  const leaveOut = leaveOutMask(pool);
  const pacer = new Pacer();
  const scores = new Float64Array(index.ids.length);
  await scoreRows(index, anchor, kind, leaveOut, scores, pacer);
  const furthest = best(scores, Math.max(count * POOL_MULTIPLIER, count), true);

  // A candidate's company counts every candidate, itself included. One pass
  // counts it for all of the furthest at once (issue #494).
  const coverage = await countNear(
    index,
    furthest.map(({ row }) => row),
    kind,
    leaveOut,
    COVERAGE_SIMILARITY_THRESHOLD,
    pacer,
  );
  return furthest
    .map(({ row, score }, j) => ({ nodeId: index.ids[row]!, score, coverage: coverage[j]! }))
    .sort((a, b) => b.coverage - a.coverage || b.score - a.score)
    .slice(0, count)
    .map(({ nodeId, score }) => ({ nodeId, score }));
}
