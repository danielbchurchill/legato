-- The one purely manual, zero-inference curatorial signal the app didn't
-- already have — not a playlist (ordered, multi-membership) and not "top
-- played" (derived from the plays table, algorithmic). One row per
-- favourited node: presence is the whole boolean, so there's no separate
-- flag that can drift out of sync with the row's own existence.
-- created_at exists only to drive GET /favourites' ordering — most recently
-- favourited first, the same "what did I just find" recency convention
-- every comparable feature (starred email, saved posts) already trains
-- people to expect.
CREATE TABLE favourites (
  node_id INTEGER PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
