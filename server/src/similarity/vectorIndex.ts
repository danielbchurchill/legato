import type { Database } from "../sqlite.js";
import { decodeInto, encodedLength, encodeVector, type SparseVector } from "./vectors.js";

// Issue #382: GET /nodes/:id/similar read and parsed every stored vector on
// every request, 3 GB of JSON at 30,000 albums, and took 19-26 s with the
// request loop blocked throughout, 13 s of it in JSON.parse. The ranking is
// a cosine against every other vector of the anchor's type, so it needs
// them all, but not from the database each time. This holds them in
// memory, packed: 24 MB at 30,000 albums, read in about 130 ms. The read
// goes a page at a time and lets the loop run every SLICE_MS or so, and
// scoring does the same, so nothing here holds the loop for long on a
// slower machine either.
export const SLICE_MS = 20;

// Issue #494: the read itself runs in the background now, as the server
// starts listening and after a recompute, so it can afford to give way
// more often than a request's own scoring. In 20 ms slices, a /health sent
// to a real server during it waited up to 42 ms on an M3 (the Pi saw 68 ms
// during #489's read); in 10 ms slices, up to 24 ms. It takes about as long
// either way.
export const READ_SLICE_MS = 10;

// A timer, not setImmediate. On Bun 1.4.2, measured on the 30k library, a
// loop yielding with setImmediate every 20 ms let a 1 ms interval run only
// every other time, and a /health that arrived as the read began waited
// 60-83 ms. With setTimeout(0), 22-26 ms and 23-51 ms.
export const yieldToLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Lets the loop run once a slice (SLICE_MS, unless it's given another
 *  length) has gone by since it last did. One is shared by everything a
 *  request runs, so several passes in a row (the dissimilar ranking's)
 *  can't add up to a long hold between them. */
export class Pacer {
  #sliceStarted = performance.now();
  readonly #sliceMs: number;

  constructor(sliceMs = SLICE_MS) {
    this.#sliceMs = sliceMs;
  }

  async pace(): Promise<void> {
    if (performance.now() - this.#sliceStarted < this.#sliceMs) return;
    await yieldToLoop();
    this.#sliceStarted = performance.now();
  }
}

/** Every stored vector, one row each, in ascending node id order. */
export type VectorIndex = {
  ids: Int32Array;
  /** The node's type, as a code from `types`. */
  kinds: Uint8Array;
  types: string[];
  /** Row r's entries are dims/values[offsets[r] .. offsets[r + 1]). */
  offsets: Int32Array;
  dims: Int32Array;
  values: Float64Array;
  norms: Float64Array;
  maxDim: number;
};

/** One page of rows, packed the way the index packs them. `ends[r]` is where
 *  row r's entries end in this page's dims and values. */
type Page = { ids: Int32Array; kinds: Uint8Array; ends: Int32Array; dims: Int32Array; values: Float64Array; norms: Float64Array };

type StoredRow = [nodeId: number, type: string, vector: Uint8Array];

// Issue #494: building the index in one go held the loop for 68 ms on a
// Raspberry Pi at 30,000 albums (2-6 ms on an M3): every row's norm, and
// copies of every array, some of them from plain arrays of 330,000 numbers.
// Growing the arrays as rows came in could also copy 12 MB inside a page.
// Now each page is packed into arrays of its own size as it's read, norms
// and all, and the index is put together from the pages one at a time, so
// no step is bigger than a page.
class Builder {
  types: string[] = [];
  pages: Page[] = [];
  rows = 0;
  entries = 0;
  maxDim = 0;

  addPage(rows: StoredRow[]): void {
    if (rows.length === 0) return;
    let entries = 0;
    for (const [, , bytes] of rows) entries += encodedLength(bytes);
    const page: Page = {
      ids: new Int32Array(rows.length),
      kinds: new Uint8Array(rows.length),
      ends: new Int32Array(rows.length),
      dims: new Int32Array(entries),
      values: new Float64Array(entries),
      norms: new Float64Array(rows.length),
    };
    let at = 0;
    for (let r = 0; r < rows.length; r++) {
      const [id, type, bytes] = rows[r]!;
      decodeInto(bytes, page.dims, page.values, at);
      const end = at + encodedLength(bytes);
      let sum = 0;
      for (let k = at; k < end; k++) {
        sum += page.values[k]! * page.values[k]!;
        if (page.dims[k]! > this.maxDim) this.maxDim = page.dims[k]!;
      }
      let kind = this.types.indexOf(type);
      if (kind < 0) kind = this.types.push(type) - 1;
      page.ids[r] = id;
      page.kinds[r] = kind;
      page.ends[r] = end;
      page.norms[r] = Math.sqrt(sum);
      at = end;
    }
    this.pages.push(page);
    this.rows += rows.length;
    this.entries += entries;
  }

  /** Puts the index together from the pages, pausing (a `yield`) after the
   *  two big allocations and after each page. */
  *build(): Generator<void, VectorIndex> {
    const dims = new Int32Array(this.entries);
    yield;
    const values = new Float64Array(this.entries);
    yield;
    const index: VectorIndex = {
      ids: new Int32Array(this.rows),
      kinds: new Uint8Array(this.rows),
      types: this.types,
      offsets: new Int32Array(this.rows + 1),
      dims,
      values,
      norms: new Float64Array(this.rows),
      maxDim: this.maxDim,
    };
    let row = 0;
    let entry = 0;
    for (const page of this.pages) {
      index.ids.set(page.ids, row);
      index.kinds.set(page.kinds, row);
      index.norms.set(page.norms, row);
      index.dims.set(page.dims, entry);
      index.values.set(page.values, entry);
      for (let r = 0; r < page.ids.length; r++) index.offsets[row + r + 1] = entry + page.ends[r]!;
      row += page.ids.length;
      entry += page.dims.length;
      yield;
    }
    this.pages = [];
    return index;
  }
}

/** For specs: an index of the given vectors, which must come in ascending
 *  node id order. */
export function indexOf(rows: { nodeId: number; type: string; vector: SparseVector }[]): VectorIndex {
  const builder = new Builder();
  builder.addPage(rows.map(({ nodeId, type, vector }) => [nodeId, type, encodeVector(vector)]));
  const steps = builder.build();
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

// Rows read per statement. A page is the most the loop can be held by one
// read: about 0.4 ms on an M3 with the file cached, decoding included.
// Pages are read until READ_SLICE_MS have gone by, then the loop runs. Sizing a
// page to fill a slice instead let one grow to 50,000 rows, and a /health
// sent to a freshly started server waited 1.5 s behind one.
const PAGE_ROWS = 1000;

/** Reads every stored vector, a page at a time. */
export async function loadVectorIndex(db: Database): Promise<VectorIndex> {
  // CROSS JOIN keeps the vectors as the outer loop. With a plain JOIN,
  // SQLite carries `node_id > ?` over to nodes.id, walks nodes from there
  // and sorts what it finds for the ORDER BY: every page read the rest of
  // the nodes table, 17 ms a page at 30,000 albums against 0.2 ms.
  const page = db.prepare(
    `SELECT f.node_id, n.type, f.vector FROM node_similarity_features f CROSS JOIN nodes n ON n.id = f.node_id
     WHERE f.node_id > ? ORDER BY f.node_id LIMIT ?`,
  );
  const builder = new Builder();
  const pacer = new Pacer(READ_SLICE_MS);
  for (let after = 0; ; ) {
    const rows = page.values(after, PAGE_ROWS) as StoredRow[];
    builder.addPage(rows);
    if (rows.length < PAGE_ROWS) break;
    after = rows[rows.length - 1]![0];
    await pacer.pace();
  }
  const steps = builder.build();
  let step = steps.next();
  while (!step.done) {
    await pacer.pace();
    step = steps.next();
  }
  // The ranking that waits on this gets a slice of its own, so it doesn't
  // add to this one's.
  await yieldToLoop();
  return step.value;
}

/** The memory the index's arrays take, in bytes. */
export function indexBytes(index: VectorIndex): number {
  const { ids, kinds, offsets, dims, values, norms } = index;
  return ids.byteLength + kinds.byteLength + offsets.byteLength + dims.byteLength + values.byteLength + norms.byteLength;
}

/** The row holding `nodeId`'s vector, or -1. */
export function rowOf(index: VectorIndex, nodeId: number): number {
  let lo = 0;
  let hi = index.ids.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const id = index.ids[mid]!;
    if (id === nodeId) return mid;
    if (id < nodeId) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

// Issue #494: on a Raspberry Pi at 30,000 albums, /dissimilar for a track
// ran its first two calls after a start at more than twice the speed of the
// rest (368 and 345 ms, then 148-173). JavaScriptCore had compiled the
// scoring loops with that request's callbacks built in, the filter and the
// function each score went to, and the next request's callbacks, new
// closures, threw the compiled code away. So the loops here take no
// callbacks: the rows a ranking leaves out come as a mask, and the scores
// go into an array (scoreRows) or are counted where they're worked out
// (countNear). Each loop is also a plain function, called once for each
// CHUNK_ROWS rows by the async one that gives way between them, rather than
// a loop inside the async function itself.
const CHUNK_ROWS = 1024;

/** Writes into `scores` the cosine similarity of row `from` to every row
 *  of `kind` that `leaveOut` doesn't mark (non-zero), and NaN for every
 *  other row. The vector at `from` is spread out once, so each row costs
 *  only its own few entries. */
export async function scoreRows(
  index: VectorIndex,
  from: number,
  kind: number,
  leaveOut: Uint8Array,
  scores: Float64Array,
  pacer = new Pacer(),
): Promise<void> {
  const spread = new Float64Array(index.maxDim + 1);
  for (let k = index.offsets[from]!; k < index.offsets[from + 1]!; k++) spread[index.dims[k]!] = index.values[k]!;
  const norm = index.norms[from]!;
  for (let first = 0; first < index.kinds.length; first += CHUNK_ROWS) {
    await pacer.pace();
    scoreChunk(index, spread, norm, kind, leaveOut, scores, first, Math.min(first + CHUNK_ROWS, index.kinds.length));
  }
}

function scoreChunk(
  index: VectorIndex,
  spread: Float64Array,
  norm: number,
  kind: number,
  leaveOut: Uint8Array,
  scores: Float64Array,
  first: number,
  end: number,
): void {
  const { kinds, offsets, dims, values, norms } = index;
  for (let r = first; r < end; r++) {
    if (kinds[r] !== kind || leaveOut[r] !== 0) {
      scores[r] = NaN;
      continue;
    }
    let dot = 0;
    for (let k = offsets[r]!; k < offsets[r + 1]!; k++) dot += spread[dims[k]!]! * values[k]!;
    scores[r] = cosine(dot, norm, norms[r]!);
  }
}

/** The cosine of two vectors from their dot product and norms, 0 when
 *  either is all zeros. */
function cosine(dot: number, normA: number, normB: number): number {
  return normA === 0 || normB === 0 ? 0 : dot / (normA * normB);
}

/** For each of `from`'s rows, how many rows of `kind` that `leaveOut`
 *  doesn't mark have a cosine similarity to it of at least `threshold`, in
 *  one pass over the index. Each similarity is worked out exactly as
 *  scoreRows works it out, so the counts are the ones its scores give. */
export async function countNear(
  index: VectorIndex,
  from: readonly number[],
  kind: number,
  leaveOut: Uint8Array,
  threshold: number,
  pacer = new Pacer(),
): Promise<Int32Array> {
  // Issue #494: /dissimilar scored every candidate against each of its 12
  // furthest, a pass each, and on a Raspberry Pi that took 400 ms for a
  // track at 30,000 albums. Here the vectors are spread out side by side,
  // so dimension d's values for all of them are together from d * stride
  // on, and each row's few entries are read for four of them at a time,
  // into four running sums. The stride is rounded up to a multiple of four;
  // the extra columns are all zeros, and their counts are dropped.
  const width = from.length;
  const stride = Math.ceil(width / 4) * 4;
  const near: Near = {
    spread: new Float64Array((index.maxDim + 1) * stride),
    stride,
    fromNorms: new Float64Array(stride),
    threshold,
    counts: new Int32Array(stride),
  };
  const { offsets, dims, values, norms } = index;
  for (let j = 0; j < width; j++) {
    const row = from[j]!;
    for (let k = offsets[row]!; k < offsets[row + 1]!; k++) near.spread[dims[k]! * stride + j] = values[k]!;
    near.fromNorms[j] = norms[row]!;
  }
  if (width > 0) {
    for (let first = 0; first < index.kinds.length; first += CHUNK_ROWS) {
      await pacer.pace();
      countChunk(index, near, kind, leaveOut, first, Math.min(first + CHUNK_ROWS, index.kinds.length));
    }
  }
  return near.counts.slice(0, width);
}

type Near = { spread: Float64Array; stride: number; fromNorms: Float64Array; threshold: number; counts: Int32Array };

function countChunk(index: VectorIndex, near: Near, kind: number, leaveOut: Uint8Array, first: number, last: number): void {
  const { kinds, offsets, dims, values, norms } = index;
  const { spread, stride, fromNorms, threshold, counts } = near;
  for (let r = first; r < last; r++) {
    if (kinds[r] !== kind || leaveOut[r] !== 0) continue;
    const start = offsets[r]!;
    const end = offsets[r + 1]!;
    const norm = norms[r]!;
    for (let j = 0; j < stride; j += 4) {
      let dot0 = 0;
      let dot1 = 0;
      let dot2 = 0;
      let dot3 = 0;
      for (let k = start; k < end; k++) {
        const at = dims[k]! * stride + j;
        const value = values[k]!;
        dot0 += spread[at]! * value;
        dot1 += spread[at + 1]! * value;
        dot2 += spread[at + 2]! * value;
        dot3 += spread[at + 3]! * value;
      }
      if (cosine(dot0, fromNorms[j]!, norm) >= threshold) counts[j]!++;
      if (cosine(dot1, fromNorms[j + 1]!, norm) >= threshold) counts[j + 1]!++;
      if (cosine(dot2, fromNorms[j + 2]!, norm) >= threshold) counts[j + 2]!++;
      if (cosine(dot3, fromNorms[j + 3]!, norm) >= threshold) counts[j + 3]!++;
    }
  }
}
