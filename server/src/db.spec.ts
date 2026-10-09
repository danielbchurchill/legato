import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BACKUPS_KEPT, MIGRATION_WAL_SHARE, openDb } from "./db.js";
import { MIGRATIONS } from "./migrations/manifest.generated.js";
import { openSqlite } from "./sqlite.js";
import { openDbAt } from "./testing.js";

// The newest migration is left pending so openDb() has exactly one thing to
// apply — the same shape as a real upgrade, without mocking the manifest.
const LATEST = MIGRATIONS[MIGRATIONS.length - 1].version;
const PREVIOUS = MIGRATIONS[MIGRATIONS.length - 2].version;

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
    openDbAt(dbPath, PREVIOUS).close();
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
    openDbAt(dbPath, LATEST).close();
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
      openDbAt(dbPath, PREVIOUS).close();
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
    openDbAt(dbPath, PREVIOUS).close();
    mkdirSync(backupsDir);
    chmodSync(backupsDir, 0o555);

    expect(() => openDb(dbPath, { log: () => {} })).toThrow(
      /Couldn't back up the database before migrating it, so no migrations were applied/,
    );
    expect(() => openDb(dbPath, { log: () => {} })).toThrow(/needs about [\d.]+ MB free/);

    expect(highestApplied(dbPath)).toBe(PREVIOUS);
    expect(readdirSync(backupsDir)).toEqual([]);
  });

  // Issue #320: the backup and the migrations write to the same disk.
  describe("free space", () => {
    // What openDb asks for: the backup, and a share of it for the -wal.
    function bytesFor(dbPath: string) {
      const db = openSqlite(dbPath);
      const { n } = db.prepare("SELECT page_count * page_size AS n FROM pragma_page_count(), pragma_page_size()").get() as {
        n: number;
      };
      db.close();
      return { backup: n, wal: Math.ceil(n * MIGRATION_WAL_SHARE) };
    }

    function freeSpace(bytes: number) {
      return spyOn(fs, "statfsSync").mockReturnValue({ bavail: bytes, bsize: 1 } as fs.StatsFs);
    }

    test("refuses to migrate when the disk has room for the backup but not for what the migrations write", () => {
      openDbAt(dbPath, PREVIOUS).close();
      const { backup, wal } = bytesFor(dbPath);
      const statfs = freeSpace(backup + wal - 1);
      try {
        expect(() => openDb(dbPath, { log: () => {} })).toThrow(
          /needs about [\d.]+ MB free \([\d.]+ MB for the backup, [\d.]+ MB for what the migrations write\), [\d.]+ MB available/,
        );
      } finally {
        statfs.mockRestore();
      }

      expect(highestApplied(dbPath)).toBe(PREVIOUS);
      expect(readdirSync(backupsDir)).toEqual([]);
    });

    test("migrates when the disk has room for both", () => {
      openDbAt(dbPath, PREVIOUS).close();
      const { backup, wal } = bytesFor(dbPath);
      const statfs = freeSpace(backup + wal);
      try {
        openDb(dbPath, { log: () => {} }).close();
      } finally {
        statfs.mockRestore();
      }

      expect(highestApplied(dbPath)).toBe(LATEST);
      expect(MIGRATION_WAL_SHARE).toBe(0.25);
    });
  });

  test("empties the write-ahead log after migrating, rather than leave it at the migrations' size", () => {
    openDbAt(dbPath, PREVIOUS).close();

    const db = openDb(dbPath, { log: () => {} });
    try {
      expect(highestApplied(dbPath)).toBe(LATEST);
      expect(statSync(`${dbPath}-wal`).size).toBe(0);
    } finally {
      db.close();
    }
  });
});
