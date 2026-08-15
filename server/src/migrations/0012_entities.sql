-- Artists and albums are not entities today — an "album" is a bare
-- 'release' nodes row with a title and nothing else. The artists/albums/
-- tracks graph toggle (session 4) and the metadata panel's aggregate rows
-- ("22 albums", a release's track count and total duration) both need real
-- aggregatable things, not a title string. These tables key 1:1 onto an
-- existing 'artist'/'release' nodes row rather than becoming a second
-- source of truth for identity — nodes still owns id/title/mbid, this is
-- purely the aggregate layer entities/aggregate.ts recomputes wholesale
-- after every scan (same pattern as layout/seed.ts's recomputeAllSeeds).
-- Cover art already keys off node_id directly (cover_art.node_id), so no
-- separate cover reference is needed here.
CREATE TABLE artists (
  node_id INTEGER PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  track_count INTEGER NOT NULL DEFAULT 0,
  album_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE albums (
  node_id INTEGER PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  -- The artist credited on the most of this release's tracks (mode, ties
  -- broken by lowest node id) — a compilation can legitimately have no
  -- single dominant artist, hence nullable.
  primary_artist_node_id INTEGER REFERENCES nodes(id),
  track_count INTEGER NOT NULL DEFAULT 0,
  total_duration_ms INTEGER NOT NULL DEFAULT 0,
  year_min INTEGER,
  year_max INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX albums_primary_artist_idx ON albums(primary_artist_node_id);
