-- Real play history, so "top artist / top album / top track" in the
-- mockup's overview block has a source — nothing in the schema counted a
-- listen before this. Rows are only ever inserted once plays/scrobble.ts's
-- threshold (50% of duration or 4 minutes, whichever first — Last.fm's own
-- rule, adopted so this ports to the deferred Last.fm/ListenBrainz work for
-- free) is met; a skipped or abandoned track never reaches POST /plays with
-- a qualifying ms_played and so is never written here at all.
CREATE TABLE plays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recording_node_id INTEGER NOT NULL REFERENCES nodes(id),
  file_id INTEGER NOT NULL REFERENCES files(id),
  started_at TEXT NOT NULL,
  ms_played INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'desktop',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX plays_recording_node_id_idx ON plays(recording_node_id);
CREATE INDEX plays_file_id_idx ON plays(file_id);
