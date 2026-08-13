-- nodes/recordings/files already exist (0002_scan.sql). This adds the
-- relationship/override layer on top, plus one column the original sketch
-- didn't account for: fuzzy_candidate_node_id holds a tier-3 suggestion's
-- proposed target until a human confirms or rejects it via
-- POST /api/v1/merge-overrides — merge_overrides itself only records
-- decisions already made, not pending ones.

ALTER TABLE files ADD COLUMN fuzzy_candidate_node_id INTEGER REFERENCES nodes(id);

CREATE TABLE merge_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id),
  forced_recording_node_id INTEGER REFERENCES nodes(id), -- NULL = force split
  decided_by TEXT NOT NULL CHECK (decided_by IN ('user','system')),
  decided_at TEXT NOT NULL DEFAULT (datetime('now')),
  reason TEXT
);

CREATE INDEX merge_overrides_file_id_idx ON merge_overrides(file_id);

CREATE TABLE edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_node INTEGER NOT NULL REFERENCES nodes(id),
  to_node INTEGER NOT NULL REFERENCES nodes(id),
  type TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('local','musicbrainz','discogs','manual')),
  label TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX edges_from_node_idx ON edges(from_node);
CREATE INDEX edges_to_node_idx ON edges(to_node);
-- Re-derivation on re-scan deletes and reinserts WHERE source = 'local'
-- specifically (see match/edges.ts) — this index makes that scoped delete
-- (and the "does this edge already exist" check) cheap.
CREATE INDEX edges_from_node_source_idx ON edges(from_node, source);

CREATE TABLE field_provenance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id INTEGER NOT NULL REFERENCES nodes(id),
  field TEXT NOT NULL,
  value TEXT,
  source TEXT NOT NULL CHECK (source IN ('local','musicbrainz','discogs','manual')),
  confidence REAL,
  is_active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX field_provenance_node_id_idx ON field_provenance(node_id);
