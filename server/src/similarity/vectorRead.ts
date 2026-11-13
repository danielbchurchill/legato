import type { Database } from "../sqlite.js";
import { loadVectorIndex, type VectorIndex } from "./vectorIndex.js";

export type VectorReadRequest = { dbPath: string };
export type VectorReadResult = { ok: true; index: VectorIndex } | { ok: false; message: string };

// Issue #494: reading the vectors on the request loop, even in 10 ms slices,
// let JavaScriptCore's collections of what the read allocates pause it: on
// a Raspberry Pi at 30,000 albums a /health waited 40-60 ms several times
// during each read. So the read runs on a Worker (vectorReadWorker.ts), as
// a recompute does, and the request loop only receives the finished arrays.
// A new Worker for each read, ended once it has answered, so its heap goes
// with it. The compiled binary finds it through scripts/compile.ts, which
// embeds it at the place this URL points to inside the binary.
//
// An in-memory database (the specs') can't be opened a second time, so it's
// read here. If the Worker can't start or doesn't answer with the vectors,
// they're read here too, in slices as before, after one warning.
export function readVectorIndex(db: Database): Promise<VectorIndex> {
  if (db.filename === ":memory:" || db.filename === "") return loadVectorIndex(db);
  return readOnWorker(db.filename).catch((err: unknown) => {
    console.warn(
      `[similarity] couldn't read the vectors on a Worker (${err instanceof Error ? err.message : String(err)}), so the request loop reads them, in slices`,
    );
    return loadVectorIndex(db);
  });
}

function readOnWorker(dbPath: string): Promise<VectorIndex> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./vectorReadWorker.ts", import.meta.url).href);
    } catch (err) {
      reject(err);
      return;
    }
    let settled = false;
    const settle = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      outcome();
    };
    worker.onmessage = (event: MessageEvent<VectorReadResult>) => {
      const result = event.data;
      settle(() => (result.ok ? resolve(result.index) : reject(new Error(result.message))));
    };
    worker.onerror = (event) => settle(() => reject(new Error(event.message || "the Worker failed")));
    worker.addEventListener("close", () => settle(() => reject(new Error("the Worker stopped before it answered"))));
    worker.postMessage({ dbPath } satisfies VectorReadRequest);
  });
}
