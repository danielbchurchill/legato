import { describe, expect, it } from "bun:test";
import { rankMostDissimilar, rankMostSimilar, type CandidatePool } from "./rank.js";
import { indexOf, scoreRows } from "./vectorIndex.js";
import { sparseVector } from "./vectors.js";

// A pool from dense test vectors: the anchor is node 0, each candidate the
// node after it, position i dimension i + 1.
function pool(anchor: number[], candidates: number[][]): CandidatePool {
  const index = indexOf(
    [anchor, ...candidates].map((values, nodeId) => ({
      nodeId,
      type: "recording",
      vector: sparseVector(values.map((value, i) => [i + 1, value])),
    })),
  );
  return { index, anchor: 0, include: () => true };
}

describe("rankMostSimilar", () => {
  it("orders candidates by descending cosine similarity to the anchor", async () => {
    const ranked = await rankMostSimilar(
      pool(
        [1, 0],
        [
          [0.7, 0.7], // 45deg off
          [0, 1], // orthogonal
          [1, 0], // identical
        ],
      ),
      3,
    );
    expect(ranked.map((r) => r.nodeId)).toEqual([3, 1, 2]);
  });

  it("respects the requested count", async () => {
    expect(await rankMostSimilar(pool([1, 0], [[1, 0], [0.9, 0.1], [0, 1]]), 1)).toHaveLength(1);
  });

  it("keeps candidates that tie in node id order", async () => {
    const ranked = await rankMostSimilar(pool([1, 0], [[0, 1], [2, 0], [0, 3], [1, 0]]), 4);
    expect(ranked.map((r) => r.nodeId)).toEqual([2, 4, 1, 3]);
  });

  it("ranks only what the pool includes, and never the anchor", async () => {
    const p = pool([1, 0], [[1, 0], [0.9, 0.1], [0, 1]]);
    const ranked = await rankMostSimilar({ ...p, include: (row) => p.index.ids[row] !== 1 }, 5);
    expect(ranked.map((r) => r.nodeId)).toEqual([2, 3]);
  });

  it("ranks only rows of the anchor's own type", async () => {
    const index = indexOf([
      { nodeId: 1, type: "release", vector: sparseVector([[1, 1]]) },
      { nodeId: 2, type: "recording", vector: sparseVector([[1, 1]]) },
      { nodeId: 3, type: "release", vector: sparseVector([[1, 0.5], [2, 1]]) },
    ]);
    const ranked = await rankMostSimilar({ index, anchor: 0, include: () => true }, 5);
    expect(ranked.map((r) => r.nodeId)).toEqual([3]);
  });
});

describe("rankMostDissimilar", () => {
  it("prefers a well-populated distant region over a single distant outlier", async () => {
    // Anchor owns dimension 0. Outlier owns dimension 1 alone — equally far
    // from the anchor as the cluster (both orthogonal, distance 1), but
    // shares no dimension with anything else, so its coverage among the
    // other candidates is zero. The cluster all share dimension 2, so
    // they're mutually similar (high coverage) while still equally distant
    // from the anchor. Tied raw distance isolates the coverage tie-break.
    const results = await rankMostDissimilar(
      pool(
        [1, 0, 0],
        [
          [0, 1, 0], // the outlier, node 1
          [0, 0, 1],
          [0, 0, 0.95],
          [0, 0, 0.9],
          [0, 0, 1.05],
        ],
      ),
      1,
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.nodeId).not.toBe(1); // the lone outlier is not picked
  });

  it("returns nothing for an empty candidate pool rather than throwing", async () => {
    expect(await rankMostDissimilar(pool([1, 0], []), 3)).toEqual([]);
  });

  it("respects the requested count", async () => {
    const candidates = Array.from({ length: 10 }, (_, i) => [Math.cos(i), Math.sin(i)]);
    expect(await rankMostDissimilar(pool([1, 0], candidates), 3)).toHaveLength(3);
  });

  // Issue #494: the coverage counts are made in one pass for all of the
  // furthest candidates instead of a pass each. The answer must be the one
  // a pass each gave, scores, ties and all.
  it("ranks as counting each candidate's company in a pass of its own did", async () => {
    // Values in quarters, so some candidates tie on distance and on company.
    const vectors = Array.from({ length: 200 }, (_, i) => [0, 1, 2, 3, 4, 5].map((d) => Math.round(Math.sin(i * (d + 1) * 1.7 + d) * 4) / 4));
    const p = { ...pool([0.3, 0.1, 0.5, 0.2, 0, 0.4], vectors), include: (row: number) => row % 17 !== 5 };
    const kind = p.index.kinds[0]!;
    const include = (row: number) => row !== p.anchor && p.include(row);

    // #489's rankMostDissimilar, with a scoreRows pass per candidate.
    async function aPassEach(count: number) {
      const scored: { row: number; distance: number }[] = [];
      await scoreRows(p.index, p.anchor, kind, include, (row, score) => scored.push({ row, distance: 1 - score }));
      const furthest = scored.sort((a, b) => b.distance - a.distance).slice(0, count * 4);
      const ranked = [];
      for (const { row, distance } of furthest) {
        let coverage = 0;
        await scoreRows(p.index, row, kind, include, (_, similarity) => {
          if (similarity >= 0.5) coverage++;
        });
        ranked.push({ nodeId: p.index.ids[row]!, score: distance, coverage });
      }
      ranked.sort((a, b) => b.coverage - a.coverage || b.score - a.score);
      return ranked.slice(0, count).map(({ nodeId, score }) => ({ nodeId, score }));
    }

    for (const count of [1, 3, 5]) {
      const expected = await aPassEach(count);
      expect(expected).toHaveLength(count);
      expect(await rankMostDissimilar(p, count)).toEqual(expected);
    }
  });
});
