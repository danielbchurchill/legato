import { describe, expect, it } from "bun:test";
import { rankMostDissimilar, rankMostSimilar, type CandidatePool } from "./rank.js";
import { indexOf } from "./vectorIndex.js";
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
});
