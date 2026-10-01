-- Issue #123: scan_jobs stops being one flat filesScanned/filesTotal
-- counter and becomes a real checkpoint row — which of the six pipeline
-- stages (discover -> read_tags -> match -> collapse -> layout ->
-- enrich_queued) a run is in, and a cursor into it, so pause survives a
-- server restart and resume picks up exactly where it left off rather than
-- re-walking or re-matching everything. Extending scan_jobs in place rather
-- than standing up a separate table this decision's own write-up calls
-- "scan_runs": every route, the frontend, and every existing test already
-- key off scan_jobs.id as the run identifier, and nothing about the
-- checkpoint needs a different identity — just more columns on the same row.
--
-- cursor is a seq index into scan_run_files (below): stages other than
-- 'discover' process that table in strict seq order, so "processed through
-- seq N" and "N files done in this stage" are the same number — no separate
-- stage_done/stage_total columns to keep in sync with it. 'layout' has no
-- per-file cursor (recompute() runs once, not per file); 0/1 stands in for
-- not-started/done there.
--
-- status's CHECK gains 'paused' and 'canceled'. SQLite has no ALTER ...
-- CHECK, so widening it means the standard rebuild-and-swap (0014, 0019).
-- Nothing holds a foreign key into scan_jobs, so the drop is safe with
-- foreign_keys on.
CREATE TABLE scan_jobs_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  library_root_id INTEGER NOT NULL REFERENCES library_roots(id),
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running','paused','canceled','done','error')),
  mode TEXT NOT NULL DEFAULT 'full' CHECK (mode IN ('full', 'incremental')),
  stage TEXT NOT NULL DEFAULT 'discover'
    CHECK (stage IN ('discover','read_tags','match','collapse','layout','enrich_queued')),
  cursor INTEGER NOT NULL DEFAULT 0,
  files_scanned INTEGER NOT NULL DEFAULT 0,
  files_added INTEGER NOT NULL DEFAULT 0,
  files_updated INTEGER NOT NULL DEFAULT 0,
  files_missing INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  paused_at TEXT,
  canceled_at TEXT,
  finished_at TEXT
);

INSERT INTO scan_jobs_new (
  id, library_root_id, status, mode, files_scanned, files_added, files_updated,
  files_missing, error_message, started_at, finished_at
)
  SELECT id, library_root_id, status, mode, files_scanned, files_added, files_updated,
         files_missing, error_message, started_at, finished_at
  FROM scan_jobs;

DROP TABLE scan_jobs;
ALTER TABLE scan_jobs_new RENAME TO scan_jobs;

CREATE INDEX scan_jobs_library_root_id_idx ON scan_jobs(library_root_id);

-- The checkpointed file list a run walks once (discover) and every later
-- stage then re-reads in seq order instead of re-walking the filesystem or
-- holding the list in memory across a run that can pause for days. Also the
-- one place an embedded cover picture's bytes live between the 'read_tags'
-- stage that extracts them and the later stage that attaches them to a
-- node's cover art (attachCoverForFile needs deriveLocalEdges — the
-- 'collapse' stage — to have already run so the release node exists) — a
-- scratch column here instead of a JS array so 100k+ pending pictures are
-- never all resident in memory at once, just whichever page of a stage's
-- loop is currently in flight.
--
-- Rows are deleted once a run finishes (done or canceled) — see
-- scanner.ts's cleanupScanRunFiles. A paused run keeps its rows; that's the
-- checkpoint.
CREATE TABLE scan_run_files (
  job_id INTEGER NOT NULL REFERENCES scan_jobs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  file_path TEXT NOT NULL,
  file_id INTEGER,
  outcome TEXT CHECK (outcome IN ('added','updated','unchanged','error')),
  picture_data BLOB,
  picture_mime TEXT,
  PRIMARY KEY (job_id, seq)
);

-- Per-file problems the scan noticed and moved past rather than stopping
-- for (H9) — a corrupt file, a permissions error, whatever a stage's
-- try/catch caught. Kept after the run finishes (unlike scan_run_files)
-- since "3 files couldn't be read, here's why" is exactly what the scan
-- panel needs to show once the run is done, not just while it's live.
CREATE TABLE scan_file_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES scan_jobs(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  stage TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX scan_file_errors_job_id_idx ON scan_file_errors(job_id);
