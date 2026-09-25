// The one file that knows the relay runs on bun:sqlite rather than
// better-sqlite3. Everything else imports the `Database` type from here
// (never from "bun:sqlite" or "better-sqlite3" directly) so swapping the
// engine again, if it ever comes to that, is a one-file change. Same
// adapter as server/src/sqlite.ts (issue #100) — kept as its own copy
// rather than a shared import because relay/ and server/ are separate
// npm packages with no shared dependency between them.
//
// The two libraries' runtime APIs line up closely enough that no shim layer
// is needed for most of the surface: .prepare()/.exec()/.transaction()/
// .close() all match, and this codebase only ever binds positional "?"
// parameters (never $name/@name), so bun:sqlite's stricter named-parameter
// rules under `strict: true` never come up. .pragma() is the one method
// that doesn't exist on bun:sqlite — callers use .exec("PRAGMA ...")
// instead (see openDb in db.ts).
//
// One real behavioral difference does need covering: bun:sqlite's
// Statement.get() returns the bare value `null` when no row matches, where
// better-sqlite3 returns `undefined`. Every `row === undefined` check and
// `toBeUndefined()` assertion in this codebase was written against that
// convention, so the wrapper below normalizes it at the source rather than
// auditing every call site. (A row whose own column is legitimately NULL
// still comes back as an object, e.g. `{ val: null }` — this only touches
// the true "no match" case, where bun:sqlite's result isn't wrapped in an
// object at all.)
import { Database as BunDatabase, type Statement as BunStatement, type SQLQueryBindings } from "bun:sqlite";

export type { SQLQueryBindings };

class Statement<ReturnType = unknown> {
  readonly #inner: BunStatement<ReturnType>;

  constructor(inner: BunStatement<ReturnType>) {
    this.#inner = inner;
  }

  get(...params: SQLQueryBindings[]): ReturnType | undefined {
    return this.#inner.get(...params) ?? undefined;
  }

  all(...params: SQLQueryBindings[]): ReturnType[] {
    return this.#inner.all(...params);
  }

  run(...params: SQLQueryBindings[]) {
    return this.#inner.run(...params);
  }
}

export class Database {
  readonly #inner: BunDatabase;

  constructor(path: string) {
    this.#inner = new BunDatabase(path, { strict: true });
  }

  prepare<ReturnType = unknown>(sql: string): Statement<ReturnType> {
    return new Statement<ReturnType>(this.#inner.prepare(sql));
  }

  // Runs one or more semicolon-separated statements without binding
  // parameters — used for PRAGMAs and for applying a migration file's SQL
  // in one call.
  exec(sql: string): void {
    this.#inner.exec(sql);
  }

  transaction<A extends unknown[], T>(fn: (...args: A) => T) {
    return this.#inner.transaction(fn);
  }

  close(): void {
    this.#inner.close();
  }
}

// dbPath is ":memory:" in tests, a real file path in production.
export function openSqlite(dbPath: string): Database {
  return new Database(dbPath);
}
