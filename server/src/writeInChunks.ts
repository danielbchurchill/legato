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

// A connection waiting for the write lock doesn't queue for it: SQLite
// sleeps and tries again, 1, 2, 5, 10, 15, 20 then 25 ms apart, and a piece
// that started the moment the last one committed takes the lock first
// every time. On a 30,000-album library a write on the request loop lost
// that race until its busy timeout ran out, then failed. So the worker
// pauses between pieces for longer than those retries are apart, once
// it's waited out a piece, and a waiting write gets in within about
// CHUNK_MS + PAUSE_MS. Only recompute's worker pauses (recomputeWorker.ts);
// on the request loop a pause would only hold up the loop.
export const PAUSE_MS = 25;
let pauseMs = 0;

/** Called once by recompute's worker, on its own thread. */
export function pauseBetweenChunks(): void {
  pauseMs = PAUSE_MS;
}

/** Calls `write` for every row, committing every CHUNK_MS. */
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
  while (!next.done) {
    writeChunk();
    if (pauseMs > 0 && !next.done) Bun.sleepSync(pauseMs);
  }
}
