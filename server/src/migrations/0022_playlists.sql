-- Real playlists: persisted, ordered, user-curated collections of tracks.
-- Distinct from favourites (0020) in both axes favourites structurally
-- can't cover — position (an ordered list, not a set) and multi-membership
-- (the same recording can sit in more than one playlist, or repeat within
-- one, e.g. a DJ set replaying a track). No uniqueness constraint on
-- node_id here on purpose, unlike favourites' node_id PRIMARY KEY.
CREATE TABLE playlists (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- position is a plain ascending integer, dense per playlist_id (1..N, no
-- gaps) — renumbered on every insert/reorder/delete by the route layer
-- rather than enforced here, since SQLite has no deferred-unique story
-- that would let a reorder pass through an intermediate colliding state.
CREATE TABLE playlist_tracks (
  id INTEGER PRIMARY KEY,
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  added_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_playlist_tracks_playlist_position ON playlist_tracks(playlist_id, position);
