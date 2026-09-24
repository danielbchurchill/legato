import { mkdirSync } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.js";
import { MIGRATIONS } from "./migrations/manifest.generated.js";
import { type Database, openSqlite } from "./sqlite.js";

function runMigrations(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const applied = new Set(
    db
      .prepare("SELECT version FROM schema_migrations")
      .all()
      .map((row) => (row as { version: number }).version),
  );

  // MIGRATIONS reads every *.sql file's contents at import time via static
  // `import … with { type: "text" }` — see manifest.generated.ts and
  // scripts/generate-migrations-manifest.mjs — instead of the readdirSync/
  // readFileSync disk scan this replaced. That scan only ever found
  // anything because dev/test/`npm run start` all run against a real
  // source tree; issue #102's compiled binary has none, so a disk read
  // here would silently apply zero migrations against a brand-new data
  // dir. If this array looks short (or db-inspector's migration count
  // looks wrong), the manifest is stale — run
  // `npm --prefix server run generate:migrations`, which check.yml also
  // verifies on every push so a forgotten regen fails loudly in CI rather
  // than shipping a binary that boots against an empty schema.
  for (const { version, sql } of MIGRATIONS) {
    if (applied.has(version)) continue;

    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(version);
    })();
  }
}

// dbPath defaults to the real on-disk DB; tests pass ":memory:" (or a temp
// file) to get the same schema/migrations against an isolated database.
export function openDb(dbPath: string = path.join(DATA_DIR, "legato.db")): Database {
  if (dbPath !== ":memory:") mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openSqlite(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
  return db;
}
