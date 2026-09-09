-- Issue #61: a "member of band" relation between two artist nodes needs
-- its own enrich_jobs job_type (enrich/members.ts, worker.ts's
-- processArtistMemberLookup) — same rate-limited, restart-surviving,
-- back-off-on-failure queue 0014 and 0019 already reuse for cover art and
-- artist photos/descriptions, rather than a second queue standing next to
-- it.
--
-- SQLite has no ALTER ... CHECK, so widening the job_type list means the
-- same rebuild-and-swap 0014 and 0019 both used.
--
-- node_id keeps meaning "the node this job is about": an artist node here,
-- same as 'artist_image_lookup' and the artist branch of
-- 'description_lookup'.
CREATE TABLE enrich_jobs_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id INTEGER REFERENCES nodes(id),
  job_type TEXT NOT NULL CHECK (
    job_type IN (
      'recording_lookup', 'cover_art_lookup', 'artist_image_lookup', 'description_lookup', 'artist_member_lookup'
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
