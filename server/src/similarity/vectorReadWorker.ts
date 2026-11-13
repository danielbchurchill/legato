// Issue #494: the Worker that vectorRead.ts starts to read the similarity
// vectors. On a Raspberry Pi at 30,000 albums the read allocates 50-70 MB
// (every row from SQLite, each page's arrays, then the index's), and
// JavaScriptCore collected that 7-9 times during it, each pause 16-35 ms on
// top of a slice, so a /health waited 40-60 ms. Here the collections pause
// this thread, not the request loop. It opens its own read-only connection
// to the same file, reads the vectors without giving way (there's no loop
// to keep), and hands the arrays back as transferables, moved, not copied.
import { openSqlite } from "../sqlite.js";
import { loadVectorIndex } from "./vectorIndex.js";
import type { VectorReadRequest, VectorReadResult } from "./vectorRead.js";

declare const self: Worker;

// A reader in WAL mode waits only while the WAL index is being rebuilt, but
// it shouldn't fail for that.
const BUSY_TIMEOUT_MS = 5_000;

self.onmessage = async (event: MessageEvent<VectorReadRequest>) => {
  let result: VectorReadResult;
  let transfer: ArrayBuffer[] = [];
  try {
    const db = openSqlite(event.data.dbPath, { readonly: true });
    try {
      db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      const index = await loadVectorIndex(db, Infinity);
      result = { ok: true, index };
      const { ids, kinds, offsets, dims, values, norms } = index;
      transfer = [ids.buffer, kinds.buffer, offsets.buffer, dims.buffer, values.buffer, norms.buffer] as ArrayBuffer[];
    } finally {
      db.close();
    }
  } catch (err) {
    result = { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  self.postMessage(result, transfer);
};
