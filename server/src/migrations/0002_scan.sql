-- Full nodes/recordings/files shape (per the MVP roadmap's M2 schema) is
-- created here rather than in a later migration: the scanner needs to write
-- match_source/confidence columns from the moment a file is first seen
-- (every freshly-scanned file starts 'unmatched' until M2's collapse
-- algorithm runs), so there is no clean intermediate shape worth migrating
-- through. M2's own migration only adds merge_overrides/edges/field_provenance
-- on top of this.

CREATE TABLE nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('recording','work','release','artist','label','credit','year')),
  title TEXT NOT NULL,
  mbid TEXT,
  discogs_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX nodes_type_mbid_unique ON nodes(type, mbid) WHERE mbid IS NOT NULL;

CREATE TABLE recordings (
  node_id INTEGER PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  canonical_duration_ms INTEGER,
  acoustid TEXT,
  work_node_id INTEGER REFERENCES nodes(id)
);

CREATE TABLE files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recording_node_id INTEGER NOT NULL REFERENCES nodes(id),
  library_root_id INTEGER NOT NULL REFERENCES library_roots(id),
  file_path TEXT NOT NULL UNIQUE,
  format TEXT,
  duration_ms INTEGER,
  bitrate INTEGER,
  sample_rate INTEGER,
  channels INTEGER,
  replaygain_track_gain REAL,
  replaygain_album_gain REAL,
  file_mtime TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  file_hash TEXT,
  match_source TEXT NOT NULL DEFAULT 'unmatched'
    CHECK (match_source IN ('mbid','acoustid','fuzzy_pending','manual','unmatched')),
  match_confidence REAL,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  missing_since TEXT,
  tags_raw TEXT
);

CREATE INDEX files_recording_node_id_idx ON files(recording_node_id);
CREATE INDEX files_library_root_id_idx ON files(library_root_id);

CREATE TABLE scan_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  library_root_id INTEGER NOT NULL REFERENCES library_roots(id),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','error')),
  files_scanned INTEGER NOT NULL DEFAULT 0,
  files_added INTEGER NOT NULL DEFAULT 0,
  files_updated INTEGER NOT NULL DEFAULT 0,
  files_missing INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);
