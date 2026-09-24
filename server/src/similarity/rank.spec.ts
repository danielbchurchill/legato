import { describe, expect, it } from "bun:test";
import { rankMostDissimilar, rankMostSimilar, type Candidate } from "./rank.js";

describe("rankMostSimilar", () => {
  it("orders candidates by descending cosine similarity to the anchor", () => {
    const anchor = [1, 0];
    const candidates: Candidate[] = [
      { nodeId: 1, vector: [1, 0] }, // identical
      { nodeId: 2, vector: [0.7, 0.7] }, // 45deg off
      { nodeId: 3, vector: [0, 1] }, // orthogonal
    ];
    const ranked = rankMostSimilar(anchor, candidates, 3);
    expect(ranked.map((r) => r.nodeId)).toEqual([1, 2, 3]);
  });

  it("respects the requested count", () => {
    const anchor = [1, 0];
    const candidates: Candidate[] = [
      { nodeId: 1, vector: [1, 0] },
      { nodeId: 2, vector: [0.9, 0.1] },
      { nodeId: 3, vector: [0, 1] },
    ];
    expect(rankMostSimilar(anchor, candidates, 1)).toHaveLength(1);
  });
});

describe("rankMostDissimilar", () => {
  it("prefers a well-populated distant region over a single distant outlier", () => {
    // Anchor owns dimension 0. Outlier owns dimension 1 alone — equally far
    // from the anchor as the cluster (both orthogonal, distance 1), but
    // shares no dimension with anything else, so its coverage among the
    // other candidates is zero. The cluster all share dimension 2, so
    // they're mutually similar (high coverage) while still equally distant
    // from the anchor. Tied raw distance isolates the coverage tie-break.
    const anchor = [1, 0, 0];
    const outlier: Candidate = { nodeId: 1, vector: [0, 1, 0] };
    const cluster: Candidate[] = [
      { nodeId: 2, vector: [0, 0, 1] },
      { nodeId: 3, vector: [0, 0, 0.95] },
      { nodeId: 4, vector: [0, 0, 0.9] },
      { nodeId: 5, vector: [0, 0, 1.05] },
    ];

    const results = rankMostDissimilar(anchor, [outlier, ...cluster], 1);
    expect(results).toHaveLength(1);
    expect(results[0].nodeId).not.toBe(1); // the lone outlier is not picked
  });

  it("returns nothing for an empty candidate pool rather than throwing", () => {
    expect(rankMostDissimilar([1, 0], [], 3)).toEqual([]);
  });

  it("respects the requested count", () => {
    const anchor = [1, 0];
    const candidates: Candidate[] = Array.from({ length: 10 }, (_, i) => ({
      nodeId: i,
      vector: [Math.cos(i), Math.sin(i)],
    }));
    expect(rankMostDissimilar(anchor, candidates, 3)).toHaveLength(3);
  });
});
