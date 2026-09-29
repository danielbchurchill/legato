import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BACKUPS_KEPT, openDb } from "./db.js";
import { MIGRATIONS } from "./migrations/manifest.generated.js";
import { openSqlite } from "./sqlite.js";

// The newest migration is left pending so openDb() has exactly one thing to
// apply — the same shape as a real upgrade, without mocking the manifest.
const LATEST = MIGRATIONS[MIGRATIONS.length - 1].version;
const PREVIOUS = MIGRATIONS[MIGRATIONS.length - 2].version;

// Builds an on-disk DB as an older release would have left it: every
// migration up to and including `upTo` applied, the rest still pending.
function buildDbAt(dbPath: string, upTo: number): void {
  const db = openSqlite(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  for (const { version, sql } of MIGRATIONS) {
    if (version > upTo) break;
    db.exec(sql);
    db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(version);
  }
  db.close();
}

function highestApplied(dbPath: string): number {
  const db = openSqlite(dbPath);
  const { version } = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as {
    version: number;
  };
  db.close();
  return version;
}

function removeDbFiles(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });
}

let dataDir: string;
let dbPath: string;
let backupsDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "legato-db-backup-test-"));
  dbPath = path.join(dataDir, "legato.db");
  backupsDir = path.join(dataDir, "backups");
});

afterEach(() => {
  // The unwritable-dir test leaves backups/ read-only; rmSync can't clear
  // its contents until that's undone.
  if (existsSync(backupsDir)) chmodSync(backupsDir, 0o755);
  rmSync(dataDir, { recursive: true, force: true });
});

describe("openDb pre-migration backup", () => {
  test("backs up a DB with pending migrations, then migrates it", () => {
    buildDbAt(dbPath, PREVIOUS);
    const log = mock((_message: string) => {});

    openDb(dbPath, { log }).close();

    const backups = readdirSync(backupsDir);
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(new RegExp(`^legato-v${PREVIOUS}-\\d{8}T\\d{6}\\.\\d{3}Z\\.db$`));
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain(path.join(backupsDir, backups[0]));
    expect(highestApplied(dbPath)).toBe(LATEST);

    // The backup is a consistent, self-contained copy of the pre-migration
    // schema — no -wal needed to read it.
    expect(highestApplied(path.join(backupsDir, backups[0]))).toBe(PREVIOUS);
  });

  test("makes no backup when nothing is pending", () => {
    buildDbAt(dbPath, LATEST);
    const log = mock((_message: string) => {});

    openDb(dbPath, { log }).close();

    expect(existsSync(backupsDir)).toBe(false);
    expect(log).not.toHaveBeenCalled();
  });

  test("makes no backup of a brand-new DB with nothing applied yet", () => {
    const log = mock((_message: string) => {});

    openDb(dbPath, { log }).close();

    expect(existsSync(backupsDir)).toBe(false);
    expect(log).not.toHaveBeenCalled();
    expect(highestApplied(dbPath)).toBe(LATEST);
  });

  test("never backs up an in-memory DB", () => {
    const log = mock((_message: string) => {});
    const cwdBackups = path.join(process.cwd(), "backups");
    const existedBefore = existsSync(cwdBackups);

    openDb(":memory:", { log }).close();

    expect(log).not.toHaveBeenCalled();
    expect(existsSync(cwdBackups)).toBe(existedBefore);
  });

  test(`keeps only the ${BACKUPS_KEPT} newest backups`, () => {
    // An old backup from a much earlier version: "v9" sorts after "v27" as
    // a string, so this also proves retention orders by timestamp, not name.
    mkdirSync(backupsDir);
    const ancient = "legato-v9-20200101T000000.000Z.db";
    writeFileSync(path.join(backupsDir, ancient), "");
    // Anything not named like an automatic backup is someone's own copy.
    const handMade = "legato-before-i-tried-something.db";
    writeFileSync(path.join(backupsDir, handMade), "");

    const made: string[] = [];
    for (let upgrade = 0; upgrade < BACKUPS_KEPT + 1; upgrade++) {
      removeDbFiles(dbPath);
      buildDbAt(dbPath, PREVIOUS);
      openDb(dbPath, { log: () => {} }).close();
      const newest = readdirSync(backupsDir)
        .filter((name) => name.startsWith(`legato-v${PREVIOUS}-`))
        .sort()
        .at(-1)!;
      made.push(newest);
      // Millisecond timestamps keep names unique; this makes sure two
      // upgrades never land in the same millisecond on a fast machine.
      Bun.sleepSync(2);
    }

    expect(new Set(made).size).toBe(BACKUPS_KEPT + 1);
    expect(readdirSync(backupsDir).sort()).toEqual([...made.slice(-BACKUPS_KEPT), handMade].sort());
  });

  // Root ignores directory permissions, so there's nothing to block there.
  test.skipIf(process.getuid?.() === 0)("a backup that can't be written blocks the migration", () => {
    buildDbAt(dbPath, PREVIOUS);
    mkdirSync(backupsDir);
    chmodSync(backupsDir, 0o555);

    expect(() => openDb(dbPath, { log: () => {} })).toThrow(
      /Couldn't back up the database before migrating it, so no migrations were applied/,
    );
    expect(() => openDb(dbPath, { log: () => {} })).toThrow(/needs about [\d.]+ MB free/);

    expect(highestApplied(dbPath)).toBe(PREVIOUS);
    expect(readdirSync(backupsDir)).toEqual([]);
  });
});
