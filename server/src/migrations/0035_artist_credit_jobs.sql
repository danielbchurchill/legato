-- Issue #273: 'artist_credit_lookup' splits a credit line joined by "," or
-- "&" in a library scanned before the server kept the evidence that splits
-- it. For each recording with such a line, it re-reads the file's ARTISTS
-- tag, and fetches MusicBrainz's artist credit when the recording is
-- matched (enrich/artistCredit.ts). It's the same rate-limited,
-- restart-surviving, back-off-on-failure queue 0024 widened for the
-- membership lookup.
--
-- SQLite has no ALTER ... CHECK, so widening the job_type list means the
-- same rebuild-and-swap 0014, 0019 and 0024 used.
--
-- node_id is a recording node here, as it is for 'recording_lookup'.
CREATE TABLE enrich_jobs_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id INTEGER REFERENCES nodes(id),
  job_type TEXT NOT NULL CHECK (
    job_type IN (
      'recording_lookup', 'cover_art_lookup', 'artist_image_lookup', 'description_lookup', 'artist_member_lookup',
      'artist_credit_lookup'
    )
  ),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','error','deferred')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  priority INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO enrich_jobs_new (id, node_id, job_type, status, attempts, next_attempt_at, priority, last_error, created_at, updated_at)
  SELECT id, node_id, job_type, status, attempts, next_attempt_at, priority, last_error, created_at, updated_at FROM enrich_jobs;

DROP TABLE enrich_jobs;
ALTER TABLE enrich_jobs_new RENAME TO enrich_jobs;

CREATE INDEX enrich_jobs_status_next_attempt_idx ON enrich_jobs(status, next_attempt_at);
CREATE INDEX enrich_jobs_node_id_idx ON enrich_jobs(node_id);
