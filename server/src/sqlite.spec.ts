import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openConnection } from "./db.js";
import type { Database } from "./sqlite.js";

// Issue #281: recompute writes on a connection of its own, so a transaction
// on the request loop's can find another connection has committed since it
// began.
describe("Database.transaction", () => {
  let dir: string;
  let a: Database;
  let b: Database;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "legato-sqlite-"));
    a = openConnection(path.join(dir, "test.db"));
    a.exec("CREATE TABLE t (x INTEGER)");
    b = openConnection(path.join(dir, "test.db"));
  });

  afterEach(() => {
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads and then writes, with no other connection's commit in between to fail it", () => {
    const readThenWrite = a.transaction(() => {
      const { n } = a.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number };
      // A deferred transaction holds no lock yet, so this commit would land
      // and the INSERT below fail with SQLITE_BUSY_SNAPSHOT.
      expect(() => b.exec("PRAGMA busy_timeout = 0; INSERT INTO t (x) VALUES (100)")).toThrow("database is locked");
      a.prepare("INSERT INTO t (x) VALUES (?)").run(n + 1);
    });
    readThenWrite();
    expect(a.prepare("SELECT x FROM t").all()).toEqual([{ x: 1 }]);
  });

  it("nests as a savepoint, rolled back with the outer one", () => {
    const insert = a.transaction((x: number) => a.prepare("INSERT INTO t (x) VALUES (?)").run(x));
    expect(() =>
      a.transaction(() => {
        insert(1);
        insert(2);
        throw new Error("boom");
      })(),
    ).toThrow("boom");
    a.transaction(() => insert(3))();
    expect(a.prepare("SELECT x FROM t").all()).toEqual([{ x: 3 }]);
  });
});
