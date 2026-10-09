import { mkdirSync, readdirSync, rmSync, statSync, statfsSync } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.js";
import { MIGRATIONS } from "./migrations/manifest.generated.js";
import { type Database, openSqlite } from "./sqlite.js";

// How many pre-migration backups survive in <data dir>/backups. Three covers
// "the last upgrade went wrong" and "the one before that went wrong too, and
// nobody noticed until now" without letting a Pi that updates weekly fill
// its SD card with copies of a database that can run to hundreds of MB.
export const BACKUPS_KEPT = 3;

// legato-v<highest applied>-<UTC timestamp>.db. The timestamp is ISO 8601
// with the separators stripped (20260929T142233.123Z) so names sort in time
// order as plain strings and carry no ':' for Windows to choke on.
// Milliseconds are kept because VACUUM INTO refuses to overwrite an
// existing file — two starts inside the same second would otherwise fail
// the second backup, and with it the migration.
const BACKUP_NAME = /^legato-v\d+-(\d{8}T\d{6}\.\d{3}Z)\.db$/;

export type OpenDbOptions = {
  // Where the "backed up before migrating" line goes. index.ts passes the
  // Fastify logger so it lands next to the other startup lines; the CLI
  // tools that also call openDb() fall back to plain stdout.
  log?: (message: string) => void;
};

function readAppliedVersions(db: Database): Set<number> {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  return new Set(
    db
      .prepare("SELECT version FROM schema_migrations")
      .all()
      .map((row) => (row as { version: number }).version),
  );
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Issue #191: migrations run in place on every start, and a packaged app,
// the Pi's compiled binary or a Docker container upgrades with nobody at a
// terminal to copy legato.db first. This is that copy, taken automatically.
//
// VACUUM INTO rather than copying the file: the live DB is in WAL mode, so
// legato.db alone can be missing committed pages still sitting in -wal, and
// copying the pair by hand while the connection is open isn't guaranteed
// consistent. VACUUM INTO writes one self-contained, already-checkpointed
// file from inside SQLite — restoring it is a single copy, no -wal/-shm.
//
// Only legato.db is backed up. The rest of the data dir (covers/,
// waveforms/) is gigabytes of cache the server rebuilds on its own, and
// copying it on every upgrade would be exactly the disk-full failure this
// is meant to protect against.
//
// Issue #320: the free-space check covers the migrations too, not just the
// backup. A migration writes every page it changes to legato.db-wal first,
// on the same disk, and a disk with room for the backup and no more let
// the backup succeed and the migration fill the disk and roll back, on
// every start. 0041, deleting 1.6M era ties from a 3,626 MB database, grew
// the -wal to 197 MB, 5.4% of the file. Rebuilding a table to widen a
// CHECK, as 0014, 0019 and 0029 did, writes about that table and its
// indexes, and apart from the similarity vectors the biggest table in that
// database is edges, 11% of it with its indexes. A quarter of the database
// covers either with room to spare. A migration that rewrites the
// similarity vectors, most of the file, has to raise this.
export const MIGRATION_WAL_SHARE = 0.25;

function backupBeforeMigrating(
  db: Database,
  dbPath: string,
  highestApplied: number,
  log: (message: string) => void,
): void {
  const backupsDir = path.join(path.dirname(dbPath), "backups");
  const timestamp = new Date().toISOString().replace(/[-:]/g, "");
  const backupPath = path.join(backupsDir, `legato-v${highestApplied}-${timestamp}.db`);

  // page_count already includes pages still in the WAL, so this is what
  // VACUUM INTO will write at most (less, once free pages are dropped).
  const { page_count: pageCount } = db.prepare("PRAGMA page_count").get() as { page_count: number };
  const { page_size: pageSize } = db.prepare("PRAGMA page_size").get() as { page_size: number };
  const backupBytes = pageCount * pageSize;
  const walBytes = Math.ceil(backupBytes * MIGRATION_WAL_SHARE);
  const bytesNeeded = backupBytes + walBytes;

  let bytesFree: number | undefined;
  try {
    mkdirSync(backupsDir, { recursive: true });
    const fsStats = statfsSync(backupsDir);
    bytesFree = fsStats.bavail * fsStats.bsize;
    if (bytesFree < bytesNeeded) {
      throw new Error(`not enough free space on the disk holding ${backupsDir}`);
    }
    // Bound parameters aren't allowed in VACUUM INTO's filename on every
    // SQLite build, so the path goes in as a quoted literal instead.
    db.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
  } catch (err) {
    // H9: say what failed, where, and what it would take to fix it — the
    // person reading this is looking at a server that refused to start.
    const cause = err instanceof Error ? err.message : String(err);
    const needed =
      `needs about ${formatMegabytes(bytesNeeded)} free (${formatMegabytes(backupBytes)} for the backup, ` +
      `${formatMegabytes(walBytes)} for what the migrations write)`;
    const space = bytesFree === undefined ? needed : `${needed}, ${formatMegabytes(bytesFree)} available`;
    throw new Error(
      `Couldn't back up the database before migrating it, so no migrations were applied and ` +
        `${dbPath} is unchanged. Tried to write ${backupPath} (${space}): ${cause}. ` +
        `Free up space or make ${backupsDir} writable, then restart the server.`,
      { cause: err },
    );
  }

  log(`database: backed up to ${backupPath} (${formatMegabytes(statSync(backupPath).size)}) before migrating`);

  // Pruned only after the new backup exists, so a failed write never costs
  // an old one. Anything in backups/ that doesn't match BACKUP_NAME (a copy
  // Daniel made by hand, say) is left alone.
  const backups = readdirSync(backupsDir)
    .map((name) => ({ name, timestamp: BACKUP_NAME.exec(name)?.[1] }))
    .filter((entry): entry is { name: string; timestamp: string } => entry.timestamp !== undefined)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  for (const { name } of backups.slice(BACKUPS_KEPT)) {
    rmSync(path.join(backupsDir, name));
  }
}

// Issue #281: how long a statement on the request loop's connection waits
// for the write lock before failing with "database is locked". recompute()
// runs on a Worker with a connection of its own, and while it holds a write
// transaction any write here has to wait for it. bun:sqlite waits by
// blocking the thread, so this is a backstop, not the design: the worker
// writes in pieces of about 50 ms with a pause after each (writeInChunks.ts),
// and the auth gate no longer writes on every request (auth/sessions.ts).
// On a 30,000-album library the longest worker transaction measured was
// 0.12 s, and no write on the request loop waited more than 84 ms. A piece
// is bounded by time, so it's no longer on a slower machine; what isn't a
// piece (a single INSERT … SELECT, the entity prune) is tens of ms there,
// several hundred on a Raspberry Pi. A second covers that with room left.
export const BUSY_TIMEOUT_MS = 1000;

/** One connection with the settings every connection to legato.db needs:
 *  WAL, so a reader never waits for a writer, and foreign keys, which
 *  SQLite turns on per connection rather than per file. openDb() is this
 *  plus migrations; recompute.ts's worker opens a second one with a longer
 *  busy timeout, since waiting there blocks nothing. */
export function openConnection(dbPath: string, busyTimeoutMs = BUSY_TIMEOUT_MS): Database {
  const db = openSqlite(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  return db;
}

// dbPath defaults to the real on-disk DB; tests pass ":memory:" (or a temp
// file) to get the same schema/migrations against an isolated database.
export function openDb(dbPath: string = path.join(DATA_DIR, "legato.db"), options: OpenDbOptions = {}): Database {
  if (dbPath !== ":memory:") mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openConnection(dbPath);

  const applied = readAppliedVersions(db);

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
  const pending = MIGRATIONS.filter(({ version }) => !applied.has(version));

  // A brand-new DB (nothing applied yet) is skipped: it holds no data, so a
  // backup would be an empty file taking up one of the three slots, and
  // pushing out a real one on a machine that was reset and rebuilt.
  if (pending.length > 0 && applied.size > 0 && dbPath !== ":memory:") {
    try {
      backupBeforeMigrating(db, dbPath, Math.max(...applied), options.log ?? console.log);
    } catch (err) {
      db.close();
      throw err;
    }
  }

  for (const { version, sql } of pending) {
    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(version);
    })();
  }

  // Issue #320: a migration that changes much of the database leaves the
  // -wal at its peak size (197 MB for 0041 at 30,000 albums) for as long as
  // the server runs. SQLite reuses the file but only shrinks it at a
  // TRUNCATE checkpoint, and nothing else has the database open yet. The
  // pages a migration frees stay in legato.db, where SQLite reuses them for
  // new rows; a VACUUM to return them would rewrite the whole file on start.
  if (pending.length > 0 && dbPath !== ":memory:") db.exec("PRAGMA wal_checkpoint(TRUNCATE)");

  return db;
}
