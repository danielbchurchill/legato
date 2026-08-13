CREATE TABLE enrich_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id INTEGER REFERENCES nodes(id),
  job_type TEXT NOT NULL CHECK (job_type IN ('recording_lookup')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','error','deferred')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  priority INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX enrich_jobs_status_next_attempt_idx ON enrich_jobs(status, next_attempt_at);
CREATE INDEX enrich_jobs_node_id_idx ON enrich_jobs(node_id);
