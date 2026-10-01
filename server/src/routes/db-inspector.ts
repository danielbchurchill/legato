import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { Database } from "../sqlite.js";
import type { FastifyInstance } from "fastify";
import { DATA_DIR } from "../config.js";

// The operational counterpart to stats.ts's OverviewBlock — that route
// answers "what's in my collection" (curatorial), this one answers "is the
// pipeline healthy and what does the schema actually look like" (engineering).
// Nothing here is cached: every query is a small COUNT/GROUP BY against
// indexed or small tables, and the cover-cache walk only runs while this one
// panel is actually open.

type LatestScanRow = {
  id: number;
  status: string;
  files_scanned: number;
  files_added: number;
  files_updated: number;
  files_missing: number;
  started_at: string;
  finished_at: string | null;
};

type StatusCountRow = { status: string; count: number };
type TypeCountRow = { type: string; count: number };

export type DbInspectorSnapshot = {
  pipeline: {
    latestScan: {
      id: number;
      status: string;
      filesScanned: number;
      filesAdded: number;
      filesUpdated: number;
      filesMissing: number;
      startedAt: string;
      finishedAt: string | null;
    } | null;
    enrichJobs: { status: string; count: number }[];
  };
  matchQuality: { source: string; count: number; share: number }[];
  schema: {
    nodesByType: { type: string; count: number }[];
    edgesByType: { type: string; count: number }[];
    files: number;
    plays: number;
    articles: number;
    fieldProvenance: number;
    coverArt: number;
    mergeOverrides: number;
    tagWrites: number;
  };
  storage: {
    dbBytes: number;
    coverCache: { fileCount: number; totalBytes: number };
  };
};

function pipelineSnapshot(db: Database): DbInspectorSnapshot["pipeline"] {
  const latest = db
    .prepare(
      `SELECT id, status, files_scanned, files_added, files_updated, files_missing, started_at, finished_at
       FROM scan_jobs ORDER BY id DESC LIMIT 1`,
    )
    .get() as LatestScanRow | undefined;

  const enrichJobs = db.prepare("SELECT status, COUNT(*) AS count FROM enrich_jobs GROUP BY status").all() as StatusCountRow[];

  return {
    latestScan: latest
      ? {
          id: latest.id,
          status: latest.status,
          filesScanned: latest.files_scanned,
          filesAdded: latest.files_added,
          filesUpdated: latest.files_updated,
          filesMissing: latest.files_missing,
          startedAt: latest.started_at,
          finishedAt: latest.finished_at,
        }
      : null,
    enrichJobs,
  };
}

function matchQualitySnapshot(db: Database): DbInspectorSnapshot["matchQuality"] {
  // Same WHERE missing_since IS NULL scope stats.ts's own track count uses —
  // a file marked missing by a re-scan is still on disk in this table, but
  // isn't part of the "live" library match quality describes.
  const rows = db
    .prepare(
      "SELECT match_source AS source, COUNT(*) AS count FROM files WHERE missing_since IS NULL GROUP BY match_source",
    )
    .all() as { source: string; count: number }[];

  const total = rows.reduce((sum, r) => sum + r.count, 0);
  return rows.map((r) => ({ ...r, share: total > 0 ? r.count / total : 0 }));
}

function schemaSnapshot(db: Database): DbInspectorSnapshot["schema"] {
  const nodesByType = db.prepare("SELECT type, COUNT(*) AS count FROM nodes GROUP BY type").all() as TypeCountRow[];
  const edgesByType = db.prepare("SELECT type, COUNT(*) AS count FROM edges GROUP BY type").all() as TypeCountRow[];

  const count = (table: string): number =>
    (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;

  return {
    nodesByType,
    edgesByType,
    files: count("files"),
    plays: count("plays"),
    articles: count("articles"),
    fieldProvenance: count("field_provenance"),
    coverArt: count("cover_art"),
    mergeOverrides: count("merge_overrides"),
    tagWrites: count("tag_writes"),
  };
}

// Recursive rather than aware of the covers/<pixel bound>/<hash prefix>/
// shape specifically (AGENTS.md's "Cover art cache") — walking generically
// means a future size added to the ladder, or a leftover directory
// pruneStaleSizes() hasn't swept yet, is still counted correctly.
function walkDirStats(dir: string): { fileCount: number; totalBytes: number } {
  let fileCount = 0;
  let totalBytes = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { fileCount: 0, totalBytes: 0 };
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = walkDirStats(full);
      fileCount += nested.fileCount;
      totalBytes += nested.totalBytes;
    } else if (entry.isFile()) {
      fileCount += 1;
      totalBytes += statSync(full).size;
    }
  }
  return { fileCount, totalBytes };
}

function storageSnapshot(dbPath: string, coverCacheDir: string): DbInspectorSnapshot["storage"] {
  let dbBytes = 0;
  try {
    dbBytes = statSync(dbPath).size;
  } catch {
    // Standalone :memory: DBs (tests) have no file on disk — 0 is correct,
    // not an error.
  }
  return { dbBytes, coverCache: walkDirStats(coverCacheDir) };
}

// dbPath/coverCacheDir default to the real on-disk locations (same
// default-param testability trick db.ts's openDb() uses) so a spec test can
// point them at a temp file/dir without touching the real DATA_DIR.
export function dbInspectorSnapshot(
  db: Database,
  dbPath: string = path.join(DATA_DIR, "legato.db"),
  coverCacheDir: string = path.join(DATA_DIR, "covers"),
): DbInspectorSnapshot {
  return {
    pipeline: pipelineSnapshot(db),
    matchQuality: matchQualitySnapshot(db),
    schema: schemaSnapshot(db),
    storage: storageSnapshot(dbPath, coverCacheDir),
  };
}

export function dbInspectorRoutes(db: Database) {
  return async function routes(app: FastifyInstance) {
    app.get("/db-inspector", async () => dbInspectorSnapshot(db));
  };
}
