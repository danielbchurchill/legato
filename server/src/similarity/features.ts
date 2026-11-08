// Metadata feature vectors for "more like this" / "completely different" —
// no DSP, no external service, per the session-1 planning decision. Every
// input here is something scan/tags.ts or entities/collaboration.ts already
// produces; this module's only job is turning that into one comparable
// numeric vector per recording.

import { sparseVector, type SparseVector } from "./vectors.js";

export type RecordingFeatureInput = {
  nodeId: number;
  genres: string[];
  primaryArtistNodeId: number | null;
  labelNodeId: number | null;
  releaseType: string | null;
  decade: number | null;
  durationMs: number | null;
  bpm: number | null;
};

export type FeatureSpace = {
  decadeRange: [number, number];
  durationRange: [number, number];
  bpmRange: [number, number];
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
export const WEIGHTS = {
  genre: 1.0,
  artist: 1.5,
  artistCluster: 0.75,
  label: 0.5,
  releaseType: 0.25,
  decade: 0.5,
  duration: 0.25,
  // P-3: tracks off the same record used to be indistinguishable —
  // genre/artist/label/type/decade are identical for every track on one
  // release, so the only prior source of separation was duration at a
  // low weight. Tempo is a real per-track characteristic (no DSP needed,
  // it's a tag field files.bpm already carries) that varies within an
  // album, so it earns a comparable weight to label/decade rather than
  // duration's.
  bpm: 0.5,
};

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

// The scalar groups' ranges across the library, which place each value in
// [-1, 1]. The one-hot groups need nothing library-wide: issue #322 keys
// each of their dimensions by the feature itself rather than by its
// position in a vocabulary.
export function buildFeatureSpace(inputs: RecordingFeatureInput[]): FeatureSpace {
  const range = (values: (number | null)[]): [number, number] => {
    const present = values.filter((v): v is number => v != null);
    return present.length > 0 ? [Math.min(...present), Math.max(...present)] : [0, 0];
  };
  return {
    decadeRange: range(inputs.map((i) => i.decade)),
    durationRange: range(inputs.map((i) => i.durationMs)),
    bpmRange: range(inputs.map((i) => i.bpm)),
  };
}

// A single scalar in [-1, 1] rather than a one-hot bucket — decade and
// duration are ordinal, and bucketing them would treat "one decade apart"
// and "five decades apart" as equally different.
function scaledScalar(value: number | null, range: [number, number]): number {
  const [min, max] = range;
  if (value == null || max === min) return 0;
  return ((value - min) / (max - min)) * 2 - 1;
}

/** Issue #322: a dimension's id for each feature key, handed out once and
 *  kept (similarity_dimensions). `added` is what this pass gave out, for the
 *  caller to store. */
export class Dimensions {
  readonly #ids: Map<string, number>;
  #next: number;
  readonly added: [key: string, id: number][] = [];

  constructor(known: Iterable<[key: string, id: number]> = []) {
    this.#ids = new Map(known);
    this.#next = 1;
    for (const id of this.#ids.values()) this.#next = Math.max(this.#next, id + 1);
  }

  id(key: string): number {
    let id = this.#ids.get(key);
    if (id === undefined) {
      id = this.#next++;
      this.#ids.set(key, id);
      this.added.push([key, id]);
    }
    return id;
  }
}

// One group of the dense vector this replaced, kept as its non-zero entries
// with the same values: a one-hot group scaled to unit length, then
// weighted. Repeats count once, as they did in a one-hot.
function oneHot(group: string, present: (string | number)[], weight: number): [string, number][] {
  const unique = [...new Set(present)];
  const value = (1 / Math.sqrt(unique.length)) * weight;
  return unique.map((key) => [`${group}:${key}`, value]);
}

// artistClusters is passed in because cluster *membership* for a given
// artist isn't something the space records.
export function buildFeatureVector(
  input: RecordingFeatureInput,
  space: FeatureSpace,
  artistClusters: Map<number, number>,
  dimensions: Dimensions,
): SparseVector {
  const artist = input.primaryArtistNodeId;
  const clusterId = artist != null ? (artistClusters.get(artist) ?? null) : null;
  const entries: [string, number][] = [
    ...oneHot("genre", input.genres, WEIGHTS.genre),
    ...oneHot("artist", artist != null ? [artist] : [], WEIGHTS.artist),
    ...oneHot("cluster", clusterId != null ? [clusterId] : [], WEIGHTS.artistCluster),
    ...oneHot("label", input.labelNodeId != null ? [input.labelNodeId] : [], WEIGHTS.label),
    ...oneHot("type", input.releaseType != null ? [input.releaseType] : [], WEIGHTS.releaseType),
    ["decade", scaledScalar(input.decade, space.decadeRange) * WEIGHTS.decade],
    ["duration", scaledScalar(input.durationMs, space.durationRange) * WEIGHTS.duration],
    ["bpm", scaledScalar(input.bpm, space.bpmRange) * WEIGHTS.bpm],
  ];
  // A zero gets no dimension, so a library with no tempo tags has no "bpm".
  return sparseVector(entries.filter(([, value]) => value !== 0).map(([key, value]) => [dimensions.id(key), value]));
}
