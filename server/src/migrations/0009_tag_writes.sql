-- field_provenance stores discovered *values* (M2/M7), not write-attempt
-- audit history — a diff someone reviewed, a write that succeeded or
-- failed, a revert. This closes that gap.
CREATE TABLE tag_writes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id),
  status TEXT NOT NULL DEFAULT 'pending_review'
    CHECK (status IN ('pending_review','approved','written','failed','reverted')),
  diff_json TEXT NOT NULL,
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  written_at TEXT,
  reverted_at TEXT,
  error_message TEXT
);

CREATE INDEX tag_writes_file_id_idx ON tag_writes(file_id);

-- app_write_marker is a write-id stamped into the file's own tag block
-- (a custom Vorbis comment field) on every app-originated write.
-- last_written_mtime is the file's mtime immediately after that write.
-- The chokidar watcher checks both before treating a change event as
-- external — the concrete fix for the self-triggering-rewrite-loop bug
-- found in a direct competitor (Musicat): write tags -> watcher sees the
-- write as an external change -> re-decides a fix is needed -> writes
-- again, forever.
ALTER TABLE files ADD COLUMN app_write_marker TEXT;
ALTER TABLE files ADD COLUMN last_written_mtime TEXT;
