import { Pacer, scoreRows, scoreRowsAgainstEach, type VectorIndex } from "./vectorIndex.js";

export type RankedResult = { nodeId: number; score: number };

/** Who's ranked: the rows of the anchor's type that `include` keeps. The
 *  anchor's own row is never one of them. */
export type CandidatePool = { index: VectorIndex; anchor: number; include: (row: number) => boolean };

function poolFilter(pool: CandidatePool): (row: number) => boolean {
  return (row) => row !== pool.anchor && pool.include(row);
}

// The best `count` by `better`, kept in order as rows arrive. A row that
// ties one already kept goes after it, so ties keep row (node id) order, as
// a stable sort over every candidate did.
function keepBest(count: number, better: (a: number, b: number) => boolean) {
  const kept: { row: number; score: number }[] = [];
  return {
    kept,
    offer(row: number, score: number) {
      if (count <= 0 || (kept.length === count && !better(score, kept[count - 1]!.score))) return;
      let at = kept.length;
      while (at > 0 && better(score, kept[at - 1]!.score)) at--;
      kept.splice(at, 0, { row, score });
      if (kept.length > count) kept.pop();
    },
  };
}

export async function rankMostSimilar(pool: CandidatePool, count: number): Promise<RankedResult[]> {
  const { index, anchor } = pool;
  const best = keepBest(count, (a, b) => a > b);
  await scoreRows(index, anchor, index.kinds[anchor]!, poolFilter(pool), best.offer);
  return best.kept.map(({ row, score }) => ({ nodeId: index.ids[row]!, score }));
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
  const include = poolFilter(pool);
  const pacer = new Pacer();
  const furthest = keepBest(Math.max(count * POOL_MULTIPLIER, count), (a, b) => a > b);
  await scoreRows(index, anchor, kind, include, (row, score) => furthest.offer(row, 1 - score), pacer);

  // A candidate's company counts every candidate, itself included. One pass
  // counts it for all of the furthest at once (issue #494).
  const coverage = new Int32Array(furthest.kept.length);
  await scoreRowsAgainstEach(
    index,
    furthest.kept.map(({ row }) => row),
    kind,
    include,
    (_, similarities) => {
      for (let j = 0; j < similarities.length; j++) if (similarities[j]! >= COVERAGE_SIMILARITY_THRESHOLD) coverage[j]!++;
    },
    pacer,
  );
  const ranked = furthest.kept.map(({ row, score }, j) => ({ nodeId: index.ids[row]!, score, coverage: coverage[j]! }));
  return ranked
    .sort((a, b) => b.coverage - a.coverage || b.score - a.score)
    .slice(0, count)
    .map(({ nodeId, score }) => ({ nodeId, score }));
}
