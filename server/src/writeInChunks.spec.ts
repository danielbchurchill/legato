import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openConnection } from "./db.js";
import type { Database } from "./sqlite.js";
import { writeInChunks } from "./writeInChunks.js";

describe("writeInChunks", () => {
  let dir: string;
  let db: Database;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "legato-chunks-"));
    db = openConnection(path.join(dir, "test.db"));
    db.exec("CREATE TABLE t (x INTEGER)");
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const insert = (x: number) => db.prepare("INSERT INTO t (x) VALUES (?)").run(x);
  const count = () => (db.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number }).n;

  it("writes every row, from an array or any other iterable", () => {
    writeInChunks(db, [1, 2, 3], insert);
    writeInChunks(db, new Set([4, 5]).values(), insert);
    writeInChunks(db, [], insert);
    expect(count()).toBe(5);
  });

  it("commits a piece once its time is up, so a failure keeps the pieces before it", () => {
    const rows = [1, 2, 3, 4];
    expect(() =>
      writeInChunks(
        db,
        rows,
        (x) => {
          if (x === 4) throw new Error("boom");
          insert(x);
          Bun.sleepSync(5);
        },
        1,
      ),
    ).toThrow("boom");
    expect(count()).toBe(3);
  });

  it("waits for a write on another connection to finish rather than failing", async () => {
    // The other connection is on a worker thread, because waiting for the
    // lock blocks this one.
    const holder = new Worker(
      URL.createObjectURL(
        new Blob([
          `import { Database } from "bun:sqlite";
           self.onmessage = (event) => {
             const db = new Database(event.data);
             db.exec("BEGIN IMMEDIATE");
             db.exec("INSERT INTO t (x) VALUES (0)");
             postMessage("locked");
             Bun.sleepSync(100);
             db.exec("COMMIT");
             db.close();
           };`,
        ]),
      ),
    );
    const locked = new Promise((resolve) => (holder.onmessage = resolve));
    holder.postMessage(path.join(dir, "test.db"));
    await locked;

    writeInChunks(db, [1], insert);
    holder.terminate();
    expect(count()).toBe(2);
  });

  // Issue #281: the case that failed on a 30,000-album library. A worker
  // writing pieces back to back starved a write on this thread until its
  // busy timeout ran out.
  it("lets a write from another connection in while recompute's worker writes piece after piece", async () => {
    const writer = new Worker(
      URL.createObjectURL(
        new Blob([
          `import { openConnection } from ${JSON.stringify(path.join(import.meta.dir, "db.ts"))};
           import { pauseBetweenChunks, writeInChunks } from ${JSON.stringify(path.join(import.meta.dir, "writeInChunks.ts"))};
           self.onmessage = (event) => {
             const db = openConnection(event.data, 60000);
             pauseBetweenChunks();
             const insert = db.prepare("INSERT INTO t (x) VALUES (?)");
             const rows = Array.from({ length: 40 }, (_, i) => i);
             let first = true;
             writeInChunks(db, rows, (x) => {
               if (first) { postMessage("writing"); first = false; }
               insert.run(x);
               Bun.sleepSync(10);
             });
             db.close();
             postMessage("done");
           };`,
        ]),
      ),
    );
    const messages: string[] = [];
    let resolveWriting!: () => void;
    let resolveDone!: () => void;
    const writing = new Promise<void>((resolve) => (resolveWriting = resolve));
    const done = new Promise<void>((resolve) => (resolveDone = resolve));
    writer.onmessage = (event: MessageEvent<string>) => {
      messages.push(event.data);
      if (event.data === "writing") resolveWriting();
      if (event.data === "done") resolveDone();
    };
    writer.postMessage(path.join(dir, "test.db"));
    await writing;

    // Five writes while the worker spends 400 ms writing 50 ms pieces.
    const waits: number[] = [];
    for (let i = 0; i < 5; i++) {
      const started = performance.now();
      insert(-1);
      waits.push(performance.now() - started);
      await Bun.sleep(20);
    }
    await done;
    writer.terminate();

    expect(count()).toBe(45);
    expect(Math.max(...waits)).toBeLessThan(250);
  });
});

