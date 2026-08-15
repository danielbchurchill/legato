-- Fetched on demand (now-playing page 2 opening a track for the first
-- time), not during scan — a network call per recording would turn a
-- normally-instant re-scan into one bounded by LRCLIB's response time for
-- every track in the library, most of which nobody will ever open the
-- lyrics page for. found=0 is a real negative cache: LRCLIB not having a
-- track is the common case for a real library (its matching-track
-- coverage is nowhere near total), and without caching that miss, every
-- panel-open would re-hit the API for a track that will never resolve.
CREATE TABLE lyrics (
  node_id INTEGER PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  plain_lyrics TEXT,
  synced_lyrics TEXT,
  instrumental INTEGER NOT NULL DEFAULT 0,
  found INTEGER NOT NULL DEFAULT 1,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);
