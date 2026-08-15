// Metadata feature vectors for "more like this" / "completely different" —
// no DSP, no external service, per the session-1 planning decision. Every
// input here is something scan/tags.ts or entities/collaboration.ts already
// produces; this module's only job is turning that into one comparable
// numeric vector per recording.

export type RecordingFeatureInput = {
  nodeId: number;
  genres: string[];
  primaryArtistNodeId: number | null;
  labelNodeId: number | null;
  releaseType: string | null;
  decade: number | null;
  durationMs: number | null;
};

export type FeatureSpace = {
  genres: string[];
  artists: number[];
  artistClusters: number[];
  labels: number[];
  releaseTypes: string[];
  decadeRange: [number, number];
  durationRange: [number, number];
};

// Weights for each feature group's contribution to the final cosine
// similarity, applied after each group's own sub-vector is L2-normalized to
// unit length — without this, a group with a large vocabulary (genre, say,
// in a library with dozens of genres) would swamp a group that is always
// exactly one dimension (release type) purely by having more dimensions to
// agree on, independent of how meaningful the match actually is.
//
// Values below are a deliberate starting point, not measured against real
// listening judgments: same-artist is weighted highest since "it's the same
// artist" is the strongest "sounds like this" signal a metadata-only engine
// can produce; artist-cluster (collaborators-of-collaborators, via the
// artists graph) is a weaker echo of the same idea. Provisional — revisit
// once this has been used against a library large and varied enough to
// judge it by ear, the same "provisional" flag DESIGN.md already carries
// for the edge-color assignment.
const WEIGHTS = {
  genre: 1.0,
  artist: 1.5,
  artistCluster: 0.75,
  label: 0.5,
  releaseType: 0.25,
  decade: 0.5,
  duration: 0.25,
};

function buildVocabulary<T>(values: Iterable<T>): T[] {
  return [...new Set(values)].sort();
}

// Connected components over the collaborated_with graph (entities/
// collaboration.ts), via union-find — two artists who never worked together
// directly but each collaborated with a third both land in the same
// cluster. Cluster id is the smallest node id in the component, so it's
// deterministic across recomputes without needing a separate id sequence.
// An artist with no collaboration edges at all is its own singleton
// cluster, identified by their own node id.
export function computeArtistClusters(collaboratedWith: { fromNode: number; toNode: number }[]): Map<number, number> {
  const parent = new Map<number, number>();
  function find(x: number): number {
    if (!parent.has(x)) parent.set(x, x);
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root) as number;
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur) as number;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    // Smaller id wins as root, so the final cluster id is deterministic
    // regardless of edge insertion order.
    if (ra < rb) parent.set(rb, ra);
    else parent.set(ra, rb);
  }

  for (const e of collaboratedWith) {
    find(e.fromNode);
    find(e.toNode);
    union(e.fromNode, e.toNode);
  }

  const result = new Map<number, number>();
  for (const node of parent.keys()) result.set(node, find(node));
  return result;
}

export function buildFeatureSpace(
  inputs: RecordingFeatureInput[],
  artistClusters: Map<number, number>,
): FeatureSpace {
  const genres = buildVocabulary(inputs.flatMap((i) => i.genres));
  const artists = buildVocabulary(
    inputs.map((i) => i.primaryArtistNodeId).filter((v): v is number => v != null),
  );
  const artistClusterIds = buildVocabulary(
    inputs
      .map((i) => (i.primaryArtistNodeId != null ? (artistClusters.get(i.primaryArtistNodeId) ?? null) : null))
      .filter((v): v is number => v != null),
  );
  const labels = buildVocabulary(inputs.map((i) => i.labelNodeId).filter((v): v is number => v != null));
  const releaseTypes = buildVocabulary(
    inputs.map((i) => i.releaseType).filter((v): v is string => v != null),
  );

  const decades = inputs.map((i) => i.decade).filter((v): v is number => v != null);
  const durations = inputs.map((i) => i.durationMs).filter((v): v is number => v != null);

  return {
    genres,
    artists,
    artistClusters: artistClusterIds,
    labels,
    releaseTypes,
    decadeRange: decades.length > 0 ? [Math.min(...decades), Math.max(...decades)] : [0, 0],
    durationRange: durations.length > 0 ? [Math.min(...durations), Math.max(...durations)] : [0, 0],
  };
}

function unitOneHot(vocab: readonly (string | number)[], present: (string | number)[]): number[] {
  const vector = new Array(vocab.length).fill(0);
  for (const value of present) {
    const index = vocab.indexOf(value);
    if (index >= 0) vector[index] = 1;
  }
  const norm = Math.hypot(...vector);
  return norm > 0 ? vector.map((v) => v / norm) : vector;
}

// A single scalar in [-1, 1] rather than a one-hot bucket — decade and
// duration are ordinal, and bucketing them would treat "one decade apart"
// and "five decades apart" as equally different.
function scaledScalar(value: number | null, range: [number, number]): number[] {
  const [min, max] = range;
  if (value == null || max === min) return [0];
  return [((value - min) / (max - min)) * 2 - 1];
}

// artistClusters is passed in (rather than looked up from FeatureSpace)
// because cluster *membership* for a given artist isn't something the
// space itself records — only the vocabulary of cluster ids it needs to
// one-hot against.
export function buildFeatureVector(
  input: RecordingFeatureInput,
  space: FeatureSpace,
  artistClusters: Map<number, number>,
): number[] {
  const clusterId =
    input.primaryArtistNodeId != null ? (artistClusters.get(input.primaryArtistNodeId) ?? null) : null;

  return [
    ...unitOneHot(space.genres, input.genres).map((v) => v * WEIGHTS.genre),
    ...unitOneHot(space.artists, input.primaryArtistNodeId != null ? [input.primaryArtistNodeId] : []).map(
      (v) => v * WEIGHTS.artist,
    ),
    ...unitOneHot(space.artistClusters, clusterId != null ? [clusterId] : []).map((v) => v * WEIGHTS.artistCluster),
    ...unitOneHot(space.labels, input.labelNodeId != null ? [input.labelNodeId] : []).map((v) => v * WEIGHTS.label),
    ...unitOneHot(space.releaseTypes, input.releaseType != null ? [input.releaseType] : []).map(
      (v) => v * WEIGHTS.releaseType,
    ),
    ...scaledScalar(input.decade, space.decadeRange).map((v) => v * WEIGHTS.decade),
    ...scaledScalar(input.durationMs, space.durationRange).map((v) => v * WEIGHTS.duration),
  ];
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error("cosineSimilarity: vectors must be the same length");
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
