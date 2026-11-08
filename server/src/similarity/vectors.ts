// Issue #322: a similarity vector as its non-zero entries only. A recording's
// has about eight (a genre or two, its artist, their cluster, its label, its
// release type, and its decade, length and tempo) out of the thousands of
// dimensions a large library has, and the dense arrays 0016 stored ran to
// 9 KB a row at 30,000 albums.
//
// A dimension is an id from similarity_dimensions, which never changes once
// given out, so a vector stays comparable with one built on another pass
// (migration 0055).

/** Entries in ascending dimension order, none of them zero. */
export type SparseVector = { dims: Int32Array; values: Float64Array };

// A 32-bit dimension id then a 64-bit value, both little-endian, per entry.
// The values stay doubles, as the JSON numbers were, so a score comes out as
// it did.
const ENTRY_BYTES = 12;

export function encodeVector(vector: SparseVector): Uint8Array {
  const bytes = new Uint8Array(vector.dims.length * ENTRY_BYTES);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < vector.dims.length; i++) {
    view.setUint32(i * ENTRY_BYTES, vector.dims[i]!, true);
    view.setFloat64(i * ENTRY_BYTES + 4, vector.values[i]!, true);
  }
  return bytes;
}

/** How many entries an encoded vector holds. */
export function encodedLength(bytes: Uint8Array): number {
  return Math.floor(bytes.byteLength / ENTRY_BYTES);
}

/** Reads an encoded vector's entries into `dims` and `values` from `at` on. */
export function decodeInto(bytes: Uint8Array, dims: Int32Array, values: Float64Array, at: number): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = encodedLength(bytes);
  for (let i = 0; i < length; i++) {
    dims[at + i] = view.getUint32(i * ENTRY_BYTES, true);
    values[at + i] = view.getFloat64(i * ENTRY_BYTES + 4, true);
  }
}

export function decodeVector(bytes: Uint8Array): SparseVector {
  const length = encodedLength(bytes);
  const vector = { dims: new Int32Array(length), values: new Float64Array(length) };
  decodeInto(bytes, vector.dims, vector.values, 0);
  return vector;
}

export function sameBytes(a: Uint8Array | undefined, b: Uint8Array): boolean {
  if (!a || a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Builds a vector from entries in any order. Zeros are left out. */
export function sparseVector(entries: Iterable<[dim: number, value: number]>): SparseVector {
  const kept = [...entries].filter(([, value]) => value !== 0).sort((a, b) => a[0] - b[0]);
  return { dims: Int32Array.from(kept, ([dim]) => dim), values: Float64Array.from(kept, ([, value]) => value) };
}

export function vectorNorm(vector: SparseVector): number {
  let sum = 0;
  for (const value of vector.values) sum += value * value;
  return Math.sqrt(sum);
}

/** Cosine similarity of two sparse vectors, walking both at once: a
 *  dimension only one of them has adds nothing. 0, not NaN, when either is
 *  all zeros. */
export function cosineSimilarity(a: SparseVector, b: SparseVector): number {
  let dot = 0;
  let i = 0;
  let j = 0;
  while (i < a.dims.length && j < b.dims.length) {
    const da = a.dims[i]!;
    const db = b.dims[j]!;
    if (da === db) dot += a.values[i++]! * b.values[j++]!;
    else if (da < db) i++;
    else j++;
  }
  const normA = vectorNorm(a);
  const normB = vectorNorm(b);
  if (normA === 0 || normB === 0) return 0;
  return dot / (normA * normB);
}

/** The per-dimension mean of `vectors`, a dimension one of them lacks
 *  counting as zero there. Each value is added as value / count, in the
 *  order given, as the dense centroid was, so it comes out the same. */
export function centroid(vectors: SparseVector[]): SparseVector {
  const sums = new Map<number, number>();
  for (const vector of vectors) {
    for (let i = 0; i < vector.dims.length; i++) {
      const dim = vector.dims[i]!;
      sums.set(dim, (sums.get(dim) ?? 0) + vector.values[i]! / vectors.length);
    }
  }
  return sparseVector(sums);
}
