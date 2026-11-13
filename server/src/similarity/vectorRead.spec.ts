import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb } from "../db.js";
import { openSqlite, type Database } from "../sqlite.js";
import { findMostSimilar, preloadSimilarityVectors, refreshSimilarityVectors } from "./similarity.js";
import { loadVectorIndex, type VectorIndex } from "./vectorIndex.js";
import { readVectorIndex } from "./vectorRead.js";
import { encodeVector, sparseVector } from "./vectors.js";

// Issue #494: the vectors are read on a Worker, so the collections of what
// the read allocates pause it and not the request loop.

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const RealWorker = globalThis.Worker;
afterEach(() => {
  globalThis.Worker = RealWorker;
});

/** A database file with `rows` vectors, over several of the read's pages,
 *  a tenth of them releases. */
function fileDb(rows = 2_500): Database {
  const dir = mkdtempSync(path.join(tmpdir(), "legato-vector-read-"));
  dirs.push(dir);
  const db = openDb(path.join(dir, "legato.db"));
  fill(db, rows);
  return db;
}

function fill(db: Database, rows: number): number[] {
  const node = db.prepare("INSERT INTO nodes (type, title) VALUES (?, 'x') RETURNING id");
  const store = db.prepare("INSERT INTO node_similarity_features (node_id, vector) VALUES (?, ?)");
  const ids: number[] = [];
  db.transaction(() => {
    for (let i = 0; i < rows; i++) {
      const id = (node.get(i % 10 === 0 ? "release" : "recording") as { id: number }).id;
      store.run(id, encodeVector(sparseVector([[1 + (i % 7), 0.5], [100 + (i % 13), (i + 1) / rows]])));
      ids.push(id);
    }
  })();
  return ids;
}

function plain(index: VectorIndex) {
  return {
    ids: [...index.ids],
    kinds: [...index.kinds],
    types: index.types,
    offsets: [...index.offsets],
    dims: [...index.dims],
    values: [...index.values],
    norms: [...index.norms],
    maxDim: index.maxDim,
  };
}

/** Counts the Workers started and ended, real ones underneath. */
function countWorkers() {
  const counts = { started: 0, ended: 0 };
  globalThis.Worker = class extends RealWorker {
    constructor(...args: ConstructorParameters<typeof Worker>) {
      super(...args);
      counts.started++;
    }
    override terminate() {
      counts.ended++;
      super.terminate();
    }
  };
  return counts;
}

type Behaviour = "answers" | "throws on start" | "errors" | "answers not ok" | "closes";

/** A stand-in Worker. "answers" reads the vectors as vectorReadWorker.ts
 *  does, on its own read-only connection, after `delayMs`; the others fail
 *  in each way a real one can. */
function fakeWorkers(behaviour: Behaviour, delayMs = 20) {
  const counts = { started: 0, ended: 0, alive: 0, mostAlive: 0 };
  globalThis.Worker = class {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    #closed: (() => void)[] = [];
    constructor() {
      if (behaviour === "throws on start") throw new Error("no Workers here");
      counts.started++;
      counts.alive++;
      counts.mostAlive = Math.max(counts.mostAlive, counts.alive);
    }
    addEventListener(type: string, listener: () => void) {
      if (type === "close") this.#closed.push(listener);
    }
    postMessage({ dbPath }: { dbPath: string }) {
      setTimeout(async () => {
        if (behaviour === "errors") return this.onerror?.({ message: "it fell over" } as ErrorEvent);
        if (behaviour === "answers not ok") return this.onmessage?.({ data: { ok: false, message: "no such table" } } as MessageEvent);
        if (behaviour === "closes") return this.#closed.forEach((listener) => listener());
        const db = openSqlite(dbPath, { readonly: true });
        const index = await loadVectorIndex(db, Infinity);
        db.close();
        this.onmessage?.({ data: { ok: true, index } } as MessageEvent);
      }, delayMs);
    }
    terminate() {
      counts.ended++;
      counts.alive--;
    }
  } as unknown as typeof Worker;
  return counts;
}

describe("readVectorIndex", () => {
  it("reads a database file on a Worker it ends once answered, into the arrays the request loop would read", async () => {
    const db = fileDb();
    const workers = countWorkers();
    const index = await readVectorIndex(db);
    expect(workers).toEqual({ started: 1, ended: 1 });
    expect(index.ids.length).toBe(2_500);
    expect(plain(index)).toEqual(plain(await loadVectorIndex(db)));
  });

  it("reads an in-memory database on the request loop, since a Worker can't open it", async () => {
    const db = openDb(":memory:");
    fill(db, 1_200);
    const workers = countWorkers();
    const index = await readVectorIndex(db);
    expect(workers.started).toBe(0);
    expect(plain(index)).toEqual(plain(await loadVectorIndex(db)));
  });

  for (const behaviour of ["throws on start", "errors", "answers not ok", "closes"] as const) {
    it(`reads on the request loop after one warning when the Worker ${behaviour}`, async () => {
      const db = fileDb(1_200);
      const workers = fakeWorkers(behaviour);
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        const index = await readVectorIndex(db);
        expect(plain(index)).toEqual(plain(await loadVectorIndex(db)));
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0]![0])).toContain("couldn't read the vectors on a Worker");
        if (behaviour !== "throws on start") expect(workers).toMatchObject({ started: 1, ended: 1 });
      } finally {
        warn.mockRestore();
      }
    });
  }
});

describe("the vectors' reads", () => {
  it("share one read between the startup read, a request and a refresh, and run one at a time", async () => {
    const db = fileDb(1_200);
    const anchor = (db.prepare("SELECT node_id FROM node_similarity_features ORDER BY node_id LIMIT 1 OFFSET 5").get() as { node_id: number }).node_id;
    const workers = fakeWorkers("answers", 30);

    // The startup read, and a request and a refresh while it's under way.
    const preload = preloadSimilarityVectors(db);
    expect(preloadSimilarityVectors(db)).toBe(preload);
    const request = findMostSimilar(db, anchor, 3);
    refreshSimilarityVectors(db);
    await Promise.all([preload, request]);
    expect(workers.started).toBe(1);

    // A recompute that changed the vectors: the refresh reads them again,
    // and a request meanwhile shares that read. Another change while it's
    // under way gets a read of its own, after it.
    db.prepare("UPDATE similarity_state SET version = version + 1 WHERE id = 1").run();
    refreshSimilarityVectors(db);
    const during = findMostSimilar(db, anchor, 3);
    db.prepare("UPDATE similarity_state SET version = version + 1 WHERE id = 1").run();
    const after = findMostSimilar(db, anchor, 3);
    await Promise.all([during, after]);
    expect(workers.started).toBe(3);
    expect(workers.mostAlive).toBe(1);
    expect(workers.ended).toBe(3);
    expect((await after).length).toBe(3);
  });
});
