-- Cover Art Archive needs a release-group MBID, which only exists once a
-- recording has already resolved to a MusicBrainz recording (the
-- 'recording_lookup' job type). Adding 'cover_art_lookup' as a second job
-- type reuses enrich_jobs's existing status/attempts/backoff machinery and
-- poller wholesale instead of standing up a second queue table — one
-- backoff policy for enrichment overall. SQLite has no ALTER ... CHECK, so
-- widening job_type's constraint means the standard rebuild-and-swap: no
-- other table holds a foreign key into enrich_jobs, so this is safe to do
-- outside a transaction-scoped foreign_keys toggle.
--
-- For a 'cover_art_lookup' job, node_id points at a *release* node (the
-- album lacking art) rather than the recording node 'recording_lookup'
-- jobs use it for — enrich_jobs.node_id has always meant "the node this
-- job is about," and which node type that is has always been implied by
-- job_type, not enforced by the schema.
CREATE TABLE enrich_jobs_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id INTEGER REFERENCES nodes(id),
  job_type TEXT NOT NULL CHECK (job_type IN ('recording_lookup', 'cover_art_lookup')),
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
