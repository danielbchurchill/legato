// Test-only helpers shared across spec files. Not a *.spec.ts itself, so
// `bun test` never picks it up as a suite of its own.
import type { Mock } from "bun:test";
import { openConnection } from "./db.js";
import { MIGRATIONS } from "./migrations/manifest.generated.js";
import type { Database } from "./sqlite.js";

// bun:test has no equivalent of vitest's `vi.mocked()`. That function does
// nothing at runtime — it's a pure type-narrowing identity, letting
// TypeScript treat an import that `mock.module()` replaced (e.g.
// `mbClient.searchArtist`) as the Mock instance it actually is, so
// `.mockResolvedValue()` etc. type-check. This is the same cast, for the
// same reason.
export function mocked<T extends (...args: never[]) => unknown>(fn: T): Mock<T> {
  return fn as unknown as Mock<T>;
}

/** An on-disk database as a release that stopped at migration `version`
 *  left it: every migration up to and including that one applied the way
 *  openDb applies them, the rest still pending, on a connection set up like
 *  a server's (WAL, foreign keys). For an upgrade spec: write the old rows,
 *  close it, and open the file with openDb. */
export function openDbAt(dbPath: string, version: number): Database {
  const db = openConnection(dbPath);
  db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");
  for (const migration of MIGRATIONS) {
    if (migration.version > version) break;
    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(migration.version);
    })();
  }
  return db;
}
