// Issue #281: the Worker that recompute.ts's recomputeOffThread() starts
// for each recompute. It opens its own connection to the same file, with
// the settings every connection gets (db.ts's openConnection), runs one
// recompute() and reports back.
import { openConnection } from "./db.js";
import { recompute, type RecomputeRequest, type RecomputeResult } from "./recompute.js";
import { pauseBetweenChunks } from "./writeInChunks.js";

declare const self: Worker;

// Waiting for the write lock blocks this thread only, so this connection
// waits out anything the request loop's connection might be writing: a
// scan's batch, a tag write, a playlist import.
const BUSY_TIMEOUT_MS = 60_000;

// Leaves the request loop's writes a way in between pieces.
pauseBetweenChunks();

function isForeignKeyFailure(err: unknown): boolean {
  return (err as { code?: string }).code === "SQLITE_CONSTRAINT_FOREIGNKEY";
}

self.onmessage = (event: MessageEvent<RecomputeRequest>) => {
  let result: RecomputeResult;
  try {
    const db = openConnection(event.data.dbPath, BUSY_TIMEOUT_MS);
    try {
      try {
        recompute(db);
      } catch (err) {
        // Each phase reads, works out what to write, then writes. A node
        // the request loop merged away in between (a credit line splitting,
        // match/people.ts's retireNodeInto) fails the write. Running it
        // again reads the merge.
        if (!isForeignKeyFailure(err)) throw err;
        recompute(db);
      }
    } finally {
      db.close();
    }
    result = { ok: true };
  } catch (err) {
    result = { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  self.postMessage(result);
};
