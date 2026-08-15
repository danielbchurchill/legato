-- M-5: candidate MBIDs used to be dumped as prose into a
-- field_provenance note ("ambiguous — 6 tied candidates, needs manual
-- confirmation: <uuid>, <uuid>, ...") — real, useful detail for a log line,
-- but a wall of UUIDs in a worklist row, with no UI able to act on any one
-- of them. A real table lets the maintenance view list each candidate
-- with something a human can actually judge (release title, year,
-- duration delta from the local file) and resolve it with one click,
-- writing through the same applyMatch path a confident automatic match
-- already uses.
--
-- label is deliberately not a column here: MusicBrainz's /recording
-- search response (what produces these candidates) doesn't include
-- label-info without a separate per-candidate lookup, and spending a
-- request per tied candidate just to populate a maintenance-view column
-- would undercut the whole point of this phase's work on cutting request
-- counts (M-2, M-6). Release title, year and duration are enough to
-- disambiguate in practice and cost nothing extra.
CREATE TABLE match_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  mbid TEXT NOT NULL,
  release_title TEXT,
  release_date TEXT,
  duration_ms INTEGER,
  score REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX match_candidates_node_id_idx ON match_candidates(node_id);
