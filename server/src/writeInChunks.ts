import type { Database } from "./sqlite.js";

// Issue #281: recompute() runs on a Worker with a connection of its own
// (recompute.ts), and while that connection holds a write transaction, a
// write on the request loop's connection waits for it, blocking the loop
// as it does (db.ts's BUSY_TIMEOUT_MS). So a phase with a lot to write
// commits it in pieces, each held for about CHUNK_MS at most. The budget is
// time rather than a row count, so a Raspberry Pi writes fewer rows per
// piece instead of holding the lock longer.
//
// Readers can see a phase half-written between two pieces. Every caller of
// recompute() broadcasts only after it has finished, so a client refetches
// once the whole thing is in.
export const CHUNK_MS = 50;

/** Calls `write` for every row, committing every CHUNK_MS. Each piece
 *  starts with BEGIN IMMEDIATE: a deferred transaction that has already
 *  read can't wait for the write lock, and fails instead. */
export function writeInChunks<T>(db: Database, rows: Iterable<T>, write: (row: T) => void, budgetMs = CHUNK_MS): void {
  const iterator = rows[Symbol.iterator]();
  let next = iterator.next();
  const writeChunk = db.transaction(() => {
    const started = performance.now();
    do {
      write(next.value as T);
      next = iterator.next();
    } while (!next.done && performance.now() - started < budgetMs);
  });
  while (!next.done) writeChunk.immediate();
}
