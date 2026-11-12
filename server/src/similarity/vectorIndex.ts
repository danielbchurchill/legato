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

// A timer, not setImmediate. On Bun 1.4.2, measured on the 30k library, a
// loop yielding with setImmediate every 20 ms let a 1 ms interval run only
// every other time, and a /health that arrived as the read began waited
// 60-83 ms. With setTimeout(0), 22-26 ms and 23-51 ms.
export const yieldToLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Lets the loop run once SLICE_MS have gone by since it last did. One is
 *  shared by everything a request runs, so several passes in a row (the
 *  dissimilar ranking's) can't add up to a long hold between them. */
export class Pacer {
  #sliceStarted = performance.now();

  async pace(): Promise<void> {
    if (performance.now() - this.#sliceStarted < SLICE_MS) return;
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
// Pages are read until SLICE_MS have gone by, then the loop runs. Sizing a
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
  const pacer = new Pacer();
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

/** Calls `visit` with the cosine similarity of row `from` to every row of
 *  `kind` that `include` keeps, in row order. The vector at `from` is
 *  spread out once, so each row costs only its own few entries. */
export async function scoreRows(
  index: VectorIndex,
  from: number,
  kind: number,
  include: (row: number) => boolean,
  visit: (row: number, score: number) => void,
  pacer = new Pacer(),
): Promise<void> {
  const spread = new Float64Array(index.maxDim + 1);
  for (let k = index.offsets[from]!; k < index.offsets[from + 1]!; k++) spread[index.dims[k]!] = index.values[k]!;
  const norm = index.norms[from]!;
  const { kinds, offsets, dims, values, norms } = index;
  for (let r = 0; r < kinds.length; r++) {
    if ((r & 1023) === 0) await pacer.pace();
    if (kinds[r] !== kind || !include(r)) continue;
    let dot = 0;
    for (let k = offsets[r]!; k < offsets[r + 1]!; k++) dot += spread[dims[k]!]! * values[k]!;
    visit(r, norm === 0 || norms[r] === 0 ? 0 : dot / (norm * norms[r]!));
  }
}

