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
  //
  // Issue #379: counted in pieces, not milliseconds, which a busy CI runner
  // stretched past the old 250 ms bound. Each row is a piece of its own
  // (a budget of 1 ms), so the rows a write waited through are the pieces
  // it waited through. Pieces that short leave the lock free for most of
  // each piece-and-pause, so a write gets in at the first pause or the one
  // after, while SQLite still retries every few milliseconds. In 50 ms
  // pieces, a write that missed the first pause on a loaded runner fell
  // back on retries 100 ms apart, which a piece-and-pause of about as long
  // kept landing inside pieces for half a second. Without the pauses, or in
  // one piece, the writes wait between them for nearly every piece, even
  // when one slips in between two.
  it("lets a write from another connection in while recompute's worker writes piece after piece", async () => {
    const PIECES = 30;
    const ROW_MS = 10;
    // A slow machine makes this thread wait longer, not fail: the count
    // below says whether it waited too long.
    db.exec("PRAGMA busy_timeout = 60000");
    const writer = new Worker(
      URL.createObjectURL(
        new Blob([
          `import { openConnection } from ${JSON.stringify(path.join(import.meta.dir, "db.ts"))};
           import { pauseBetweenChunks, writeInChunks } from ${JSON.stringify(path.join(import.meta.dir, "writeInChunks.ts"))};
           self.onmessage = (event) => {
             const db = openConnection(event.data, 60000);
             pauseBetweenChunks();
             const insert = db.prepare("INSERT INTO t (x) VALUES (?)");
             const rows = Array.from({ length: ${PIECES} }, (_, i) => i);
             let first = true;
             writeInChunks(db, rows, (x) => {
               if (first) { postMessage("writing"); first = false; }
               insert.run(x);
               Bun.sleepSync(${ROW_MS});
             }, 1);
             db.close();
             postMessage("done");
           };`,
        ]),
      ),
    );
    let resolveWriting!: () => void;
    let resolveDone!: () => void;
    const writing = new Promise<void>((resolve) => (resolveWriting = resolve));
    const done = new Promise<void>((resolve) => (resolveDone = resolve));
    writer.onmessage = (event: MessageEvent<string>) => {
      if (event.data === "writing") resolveWriting();
      if (event.data === "done") resolveDone();
    };
    writer.postMessage(path.join(dir, "test.db"));
    await writing;

    // Five writes while the worker writes its pieces, each noting how many
    // of them were in when it started to wait.
    const committed = () => (db.prepare("SELECT COUNT(*) AS n FROM t WHERE x >= 0").get() as { n: number }).n;
    const writes: { x: number; before: number }[] = [];
    for (let x = -1; x >= -5; x--) {
      writes.push({ x, before: committed() });
      insert(x);
      await Bun.sleep(20);
    }
    await done;
    writer.terminate();
    expect(count()).toBe(PIECES + 5);

    // The rows in the order they got the lock, how many of the worker's
    // pieces each write waited through, and how many all five did.
    const order = (db.prepare("SELECT x FROM t ORDER BY rowid").all() as { x: number }[]).map((row) => row.x);
    const waitedThrough = writes.map(({ x, before }) => order.slice(0, order.indexOf(x)).filter((y) => y >= 0).length - before);
    expect(waitedThrough.reduce((sum, n) => sum + n)).toBeLessThan(PIECES / 2);
  });
});
