import { describe, expect, it } from "vitest";
import {
  buildFeatureSpace,
  buildFeatureVector,
  computeArtistClusters,
  cosineSimilarity,
  type RecordingFeatureInput,
} from "./features.js";

describe("cosineSimilarity", () => {
  it("is 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });

  it("is 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("is 0, not NaN, when either vector is all zeros", () => {
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(0);
    expect(cosineSimilarity([1, 2], [0, 0])).toBe(0);
  });

  it("rejects mismatched lengths rather than silently comparing a prefix", () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow();
  });
});

describe("computeArtistClusters", () => {
  it("groups artists connected directly or transitively into one cluster", () => {
    const edges = [
      { fromNode: 10, toNode: 20 },
      { fromNode: 20, toNode: 30 }, // 10-20-30 transitively connected
      { fromNode: 40, toNode: 50 }, // separate cluster
    ];
    const clusters = computeArtistClusters(edges);
    expect(clusters.get(10)).toBe(clusters.get(30)); // same cluster despite no direct edge
    expect(clusters.get(10)).not.toBe(clusters.get(40));
  });

  it("assigns cluster ids deterministically as the smallest member id", () => {
    const clusters = computeArtistClusters([
      { fromNode: 30, toNode: 10 },
      { fromNode: 10, toNode: 20 },
    ]);
    expect(clusters.get(10)).toBe(10);
    expect(clusters.get(20)).toBe(10);
    expect(clusters.get(30)).toBe(10);
  });
});

describe("buildFeatureVector", () => {
  function input(overrides: Partial<RecordingFeatureInput> = {}): RecordingFeatureInput {
    return {
      nodeId: 1,
      genres: [],
      primaryArtistNodeId: null,
      labelNodeId: null,
      releaseType: null,
      decade: null,
      durationMs: null,
      ...overrides,
    };
  }

  it("gives two recordings by the same artist a higher similarity than two by different artists", () => {
    const beatlesA = input({ nodeId: 1, primaryArtistNodeId: 100, genres: ["rock"] });
    const beatlesB = input({ nodeId: 2, primaryArtistNodeId: 100, genres: ["pop"] });
    const dylan = input({ nodeId: 3, primaryArtistNodeId: 200, genres: ["rock"] });

    const inputs = [beatlesA, beatlesB, dylan];
    const clusters = new Map<number, number>(); // no collaboration edges in this scenario
    const space = buildFeatureSpace(inputs, clusters);

    const vA = buildFeatureVector(beatlesA, space, clusters);
    const vB = buildFeatureVector(beatlesB, space, clusters);
    const vDylan = buildFeatureVector(dylan, space, clusters);

    const sameArtistDifferentGenre = cosineSimilarity(vA, vB);
    const differentArtistSameGenre = cosineSimilarity(vA, vDylan);
    expect(sameArtistDifferentGenre).toBeGreaterThan(differentArtistSameGenre);
  });

  it("gives two recordings by collaborating artists a higher similarity than two by unrelated artists", () => {
    const anchor = input({ nodeId: 1, primaryArtistNodeId: 100 });
    const collaborator = input({ nodeId: 2, primaryArtistNodeId: 101 });
    const unrelated = input({ nodeId: 3, primaryArtistNodeId: 102 });

    const inputs = [anchor, collaborator, unrelated];
    const clusters = computeArtistClusters([{ fromNode: 100, toNode: 101 }]); // 100 & 101 collaborated; 102 didn't
    const space = buildFeatureSpace(inputs, clusters);

    const vAnchor = buildFeatureVector(anchor, space, clusters);
    const vCollaborator = buildFeatureVector(collaborator, space, clusters);
    const vUnrelated = buildFeatureVector(unrelated, space, clusters);

    expect(cosineSimilarity(vAnchor, vCollaborator)).toBeGreaterThan(cosineSimilarity(vAnchor, vUnrelated));
  });

  it("gives closer decades a higher similarity than distant ones, all else equal", () => {
    const anchor = input({ nodeId: 1, decade: 1970 });
    const near = input({ nodeId: 2, decade: 1980 });
    const far = input({ nodeId: 3, decade: 2020 });

    const inputs = [anchor, near, far];
    const clusters = new Map<number, number>();
    const space = buildFeatureSpace(inputs, clusters);

    const vAnchor = buildFeatureVector(anchor, space, clusters);
    const vNear = buildFeatureVector(near, space, clusters);
    const vFar = buildFeatureVector(far, space, clusters);

    expect(cosineSimilarity(vAnchor, vNear)).toBeGreaterThan(cosineSimilarity(vAnchor, vFar));
  });

  it("produces a finite vector for a recording with no data at all", () => {
    const bare = input({ nodeId: 1 });
    const space = buildFeatureSpace([bare], new Map());
    const vector = buildFeatureVector(bare, space, new Map());
    expect(vector.every((v) => Number.isFinite(v))).toBe(true);
  });
});
