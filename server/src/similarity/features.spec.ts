import { describe, expect, it } from "bun:test";
import {
  buildFeatureSpace,
  buildFeatureVector,
  computeArtistClusters,
  Dimensions,
  WEIGHTS,
  type RecordingFeatureInput,
} from "./features.js";
import { centroid, cosineSimilarity } from "./vectors.js";

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

function input(overrides: Partial<RecordingFeatureInput> = {}): RecordingFeatureInput {
  return {
    nodeId: 1,
    genres: [],
    primaryArtistNodeId: null,
    labelNodeId: null,
    releaseType: null,
    decade: null,
    durationMs: null,
    bpm: null,
    ...overrides,
  };
}

describe("buildFeatureVector", () => {
  function vectors(inputs: RecordingFeatureInput[], clusters = new Map<number, number>()) {
    const space = buildFeatureSpace(inputs);
    const dimensions = new Dimensions();
    return inputs.map((i) => buildFeatureVector(i, space, clusters, dimensions));
  }

  it("gives two recordings by the same artist a higher similarity than two by different artists", () => {
    const [vA, vB, vDylan] = vectors([
      input({ nodeId: 1, primaryArtistNodeId: 100, genres: ["rock"] }),
      input({ nodeId: 2, primaryArtistNodeId: 100, genres: ["pop"] }),
      input({ nodeId: 3, primaryArtistNodeId: 200, genres: ["rock"] }),
    ]);
    expect(cosineSimilarity(vA!, vB!)).toBeGreaterThan(cosineSimilarity(vA!, vDylan!));
  });

  it("gives two recordings by collaborating artists a higher similarity than two by unrelated artists", () => {
    const clusters = computeArtistClusters([{ fromNode: 100, toNode: 101 }]); // 100 & 101 collaborated; 102 didn't
    const [vAnchor, vCollaborator, vUnrelated] = vectors(
      [
        input({ nodeId: 1, primaryArtistNodeId: 100 }),
        input({ nodeId: 2, primaryArtistNodeId: 101 }),
        input({ nodeId: 3, primaryArtistNodeId: 102 }),
      ],
      clusters,
    );
    expect(cosineSimilarity(vAnchor!, vCollaborator!)).toBeGreaterThan(cosineSimilarity(vAnchor!, vUnrelated!));
  });

  it("gives closer decades a higher similarity than distant ones, all else equal", () => {
    const [vAnchor, vNear, vFar] = vectors([
      input({ nodeId: 1, decade: 1970 }),
      input({ nodeId: 2, decade: 1980 }),
      input({ nodeId: 3, decade: 2020 }),
    ]);
    expect(cosineSimilarity(vAnchor!, vNear!)).toBeGreaterThan(cosineSimilarity(vAnchor!, vFar!));
  });

  it("gives closer bpm a higher similarity than distant bpm, all else equal (P-3's within-album discriminator)", () => {
    const [vAnchor, vNear, vFar] = vectors([
      input({ nodeId: 1, bpm: 120 }),
      input({ nodeId: 2, bpm: 124 }),
      input({ nodeId: 3, bpm: 70 }),
    ]);
    expect(cosineSimilarity(vAnchor!, vNear!)).toBeGreaterThan(cosineSimilarity(vAnchor!, vFar!));
  });

  it("produces an empty vector for a recording with no data at all", () => {
    const [bare] = vectors([input({ nodeId: 1 })]);
    expect(bare!.dims.length).toBe(0);
    expect(cosineSimilarity(bare!, bare!)).toBe(0);
  });

  // Issue #322: only what the recording has, against ids that don't move.
  it("holds only the recording's own features, each once", () => {
    const dimensions = new Dimensions();
    const space = buildFeatureSpace([input({ decade: 1960 }), input({ decade: 1980 })]);
    const vector = buildFeatureVector(
      input({ genres: ["rock", "pop", "rock"], primaryArtistNodeId: 7, labelNodeId: 9, decade: 1980 }),
      space,
      new Map([[7, 5]]),
      dimensions,
    );
    expect(dimensions.added.map(([key]) => key)).toEqual(["genre:rock", "genre:pop", "artist:7", "cluster:5", "label:9", "decade"]);
    expect([...vector.values]).toEqual([
      WEIGHTS.genre / Math.SQRT2,
      WEIGHTS.genre / Math.SQRT2,
      WEIGHTS.artist,
      WEIGHTS.artistCluster,
      WEIGHTS.label,
      WEIGHTS.decade,
    ]);
  });
});

describe("Dimensions", () => {
  it("keeps the ids it's given and hands out new ones after the highest", () => {
    const dimensions = new Dimensions([
      ["genre:rock", 1],
      ["artist:7", 4],
    ]);
    expect(dimensions.id("artist:7")).toBe(4);
    expect(dimensions.id("genre:jazz")).toBe(5);
    expect(dimensions.id("genre:jazz")).toBe(5);
    expect(dimensions.id("genre:rock")).toBe(1);
    expect(dimensions.added).toEqual([["genre:jazz", 5]]);
  });

  it("gives a recording the same vector whatever else the library has", () => {
    const rock = input({ nodeId: 1, genres: ["rock"], primaryArtistNodeId: 7 });
    const before = new Dimensions();
    const alone = buildFeatureVector(rock, buildFeatureSpace([rock]), new Map(), before);
    // A later pass: new genres and artists, some sorting before this one's.
    const after = new Dimensions(before.added);
    const others = [input({ nodeId: 2, genres: ["ambient"], primaryArtistNodeId: 3 }), rock];
    const space = buildFeatureSpace(others);
    for (const other of others) buildFeatureVector(other, space, new Map(), after);
    const again = buildFeatureVector(rock, space, new Map(), after);
    expect(again).toEqual(alone);
  });
});

// Issue #322: the dense vectors this replaced, built as 0016's code built
// them: every group one-hot over the whole sorted vocabulary, scaled to unit
// length and weighted, then the scalars. A sparse vector has to score what
// they scored.
describe("against the dense vectors", () => {
  function dense(inputs: RecordingFeatureInput[], clusters: Map<number, number>): number[][] {
    const vocab = <T>(values: (T | null)[]) => [...new Set(values.filter((v): v is T => v != null))].sort();
    const clusterOf = (i: RecordingFeatureInput) =>
      i.primaryArtistNodeId != null ? (clusters.get(i.primaryArtistNodeId) ?? null) : null;
    const genres = vocab(inputs.flatMap((i) => i.genres));
    const artists = vocab(inputs.map((i) => i.primaryArtistNodeId));
    const clusterIds = vocab(inputs.map(clusterOf));
    const labels = vocab(inputs.map((i) => i.labelNodeId));
    const types = vocab(inputs.map((i) => i.releaseType));
    const space = buildFeatureSpace(inputs);
    const oneHot = (v: readonly (string | number)[], present: (string | number)[], weight: number) => {
      const vector = v.map((x) => (present.includes(x) ? 1 : 0));
      const norm = Math.hypot(...vector);
      return vector.map((x) => (norm > 0 ? x / norm : x) * weight);
    };
    const scalar = (value: number | null, [min, max]: [number, number], weight: number) =>
      value == null || max === min ? 0 : (((value - min) / (max - min)) * 2 - 1) * weight;
    return inputs.map((i) => [
      ...oneHot(genres, i.genres, WEIGHTS.genre),
      ...oneHot(artists, i.primaryArtistNodeId != null ? [i.primaryArtistNodeId] : [], WEIGHTS.artist),
      ...oneHot(clusterIds, clusterOf(i) != null ? [clusterOf(i)!] : [], WEIGHTS.artistCluster),
      ...oneHot(labels, i.labelNodeId != null ? [i.labelNodeId] : [], WEIGHTS.label),
      ...oneHot(types, i.releaseType != null ? [i.releaseType] : [], WEIGHTS.releaseType),
      scalar(i.decade, space.decadeRange, WEIGHTS.decade),
      scalar(i.durationMs, space.durationRange, WEIGHTS.duration),
      scalar(i.bpm, space.bpmRange, WEIGHTS.bpm),
    ]);
  }

  function denseCosine(a: number[], b: number[]): number {
    let dot = 0;
    let na = 0;
    let nb = 0;
    a.forEach((x, i) => {
      dot += x * b[i]!;
      na += x * x;
      nb += b[i]! * b[i]!;
    });
    return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  // A small library with every kind of feature, some missing on each.
  let seed = 7;
  const rand = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
  const pick = <T>(list: T[]) => list[Math.floor(rand() * list.length)]!;
  const inputs = Array.from({ length: 60 }, (_, n) =>
    input({
      nodeId: n + 1,
      genres: rand() < 0.2 ? [] : Array.from({ length: 1 + Math.floor(rand() * 3) }, () => pick(["rock", "pop", "jazz", "folk", "ambient"])),
      primaryArtistNodeId: rand() < 0.1 ? null : 100 + Math.floor(rand() * 8),
      labelNodeId: rand() < 0.3 ? null : 200 + Math.floor(rand() * 4),
      releaseType: rand() < 0.3 ? null : pick(["album", "single", "ep"]),
      decade: rand() < 0.2 ? null : 1960 + 10 * Math.floor(rand() * 6),
      durationMs: rand() < 0.1 ? null : 90_000 + Math.floor(rand() * 300_000),
      bpm: rand() < 0.5 ? null : 60 + Math.floor(rand() * 100),
    }),
  );
  const clusters = computeArtistClusters([
    { fromNode: 100, toNode: 101 },
    { fromNode: 101, toNode: 104 },
    { fromNode: 105, toNode: 106 },
  ]);

  it("scores every pair of recordings as the dense vectors did", () => {
    const old = dense(inputs, clusters);
    const space = buildFeatureSpace(inputs);
    const dimensions = new Dimensions();
    const sparse = inputs.map((i) => buildFeatureVector(i, space, clusters, dimensions));
    for (let a = 0; a < inputs.length; a++) {
      for (let b = 0; b < inputs.length; b++) {
        expect(cosineSimilarity(sparse[a]!, sparse[b]!)).toBeCloseTo(denseCosine(old[a]!, old[b]!), 12);
      }
    }
  });

  it("scores albums, the centroid of their tracks, as the dense vectors did", () => {
    const old = dense(inputs, clusters);
    const space = buildFeatureSpace(inputs);
    const dimensions = new Dimensions();
    const sparse = inputs.map((i) => buildFeatureVector(i, space, clusters, dimensions));
    const albums = [0, 10, 20, 30, 40, 50].map((start) => ({ from: start, to: start + 1 + (start % 7) }));
    const denseAlbums = albums.map(({ from, to }) => {
      const tracks = old.slice(from, to);
      return tracks[0]!.map((_, d) => tracks.reduce((sum, t) => sum + t[d]! / tracks.length, 0));
    });
    const sparseAlbums = albums.map(({ from, to }) => centroid(sparse.slice(from, to)));
    for (let a = 0; a < albums.length; a++) {
      for (let b = 0; b < albums.length; b++) {
        expect(cosineSimilarity(sparseAlbums[a]!, sparseAlbums[b]!)).toBeCloseTo(denseCosine(denseAlbums[a]!, denseAlbums[b]!), 12);
      }
    }
  });
});
