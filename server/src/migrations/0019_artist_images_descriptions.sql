-- Two things the graph has never had a place to put: a photograph of an
-- artist, and a sentence about who they are.
--
-- Both are *outside* facts: articles (0005) and facts.ts only ever state
-- what this library itself proves — twelve tracks, three collaborators, a
-- shared label. Neither can say that Genesis Owusu is a Ghanaian-Australian
-- musician from Canberra, because nothing in a FLAC tag knows that. This
-- migration adds the storage for editorial prose fetched from an outside
-- source, and widens the two CHECK constraints that stood in the way of an
-- artist node holding art of its own.

-- Descriptions are cached per node with a real negative cache (found = 0),
-- same shape and same reasoning as lyrics (0017): a Wikipedia lookup is a
-- network round trip, most nodes in a real library resolve to nothing, and
-- without recording the miss every panel-open would re-hit the API for an
-- artist who will never have an article.
--
-- Deliberately not merged into articles: that table is recomputed wholesale
-- after every scan (articles/recompute.ts), so anything fetched from a
-- network would be destroyed by the next re-scan. They are also different
-- kinds of text with different provenance, and the panel shows them as
-- different sections — one is about your collection, the other is about the
-- artist.
CREATE TABLE descriptions (
  node_id INTEGER PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  body TEXT,
  -- Which service the prose came from ('wikipedia'). Not a CHECK: a second
  -- provider should be a one-line addition in the fetcher, not a table
  -- rebuild.
  source TEXT NOT NULL,
  -- The page this text came from. Attribution, not decoration — Wikipedia
  -- content is CC BY-SA, so the UI has to be able to link back to it.
  source_url TEXT,
  license TEXT,
  found INTEGER NOT NULL DEFAULT 1,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- cover_art.source gains 'artist_image': a photo of an artist, fetched by
-- name (enrich/deezer.ts), attached to the artist node itself. It shares
-- this table rather than getting its own because everything downstream of
-- storage is identical — the same on-disk cache, the same derived sizes, the
-- same by-hash and by-node routes, the same manual-override precedence. What
-- differs is only which node it hangs off and what it depicts.
--
-- The remote URL it came from goes in origin_path, the same column a folder
-- cover's file path uses: "where this image came from" is the question that
-- column has always answered, and a URL is a legitimate answer to it. That
-- also records which provider supplied it, since the host is right there in
-- the URL.
--
-- SQLite has no ALTER ... CHECK, so widening means the standard
-- rebuild-and-swap (see 0014, which did this to enrich_jobs). Nothing holds
-- a foreign key *into* cover_art, so the drop is safe with foreign_keys on;
-- its own outgoing references to nodes/files are re-declared below.
CREATE TABLE cover_art_new (
  id INTEGER PRIMARY KEY,
  node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('embedded', 'folder', 'caa', 'manual', 'artist_image')),
  hash TEXT NOT NULL,
  mime TEXT,
  origin_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
  origin_path TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO cover_art_new (id, node_id, source, hash, mime, origin_file_id, origin_path, created_at, updated_at)
  SELECT id, node_id, source, hash, mime, origin_file_id, origin_path, created_at, updated_at FROM cover_art;

DROP TABLE cover_art;
ALTER TABLE cover_art_new RENAME TO cover_art;

CREATE UNIQUE INDEX cover_art_node_source ON cover_art (node_id, source);
CREATE INDEX cover_art_hash ON cover_art (hash);

-- enrich_jobs.job_type gains the two new lookups, reusing the existing
-- status/attempts/backoff/poller machinery rather than standing up a second
-- queue — same call 0014 made for cover art, and the reason both of these
-- are jobs at all: they are rate-limited network work that must survive a
-- restart and back off on failure.
--
-- node_id continues to mean "the node this job is about", with the type
-- implied by job_type: an artist node for 'artist_image_lookup', an artist
-- or release node for 'description_lookup'.
CREATE TABLE enrich_jobs_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id INTEGER REFERENCES nodes(id),
  job_type TEXT NOT NULL CHECK (
    job_type IN ('recording_lookup', 'cover_art_lookup', 'artist_image_lookup', 'description_lookup')
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
