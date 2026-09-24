-- Issue #124: M3U/M3U8 import's match report needs to survive past the
-- request that produced it ("report stays viewable" is one of the issue's
-- three done-when items, not a nice-to-have) rather than being a one-shot
-- response the client has to hold onto in memory. One row per import run
-- (playlist_imports), one row per line the source file listed
-- (playlist_import_entries) — including the ones that matched nothing,
-- since "what's missing" is the report's whole point.
--
-- Deliberately its own pair of tables rather than columns bolted onto
-- playlist_tracks: an entry that matched nothing never gets a
-- playlist_tracks row to attach to, and the report needs to list it
-- anyway. playlist_id, not playlist_track_id, is the join key here.
CREATE TABLE playlist_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  source_filename TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX playlist_imports_playlist_id_idx ON playlist_imports(playlist_id);

-- position preserves the source file's original track order, independent
-- of playlist_tracks.position — that column only exists for entries that
-- actually matched, and gets renumbered by every mutation in playlists.ts
-- (see that file's own header comment), so it can't double as "where was
-- this in the M3U".
--
-- extinf_* columns hold whatever the file's #EXTINF line parsed to
-- (m3u-parse.ts) — null across all three when the source had no EXTINF
-- for that entry, which is itself part of the report (it's the reason a
-- path-match miss couldn't fall back to metadata matching).
CREATE TABLE playlist_import_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id INTEGER NOT NULL REFERENCES playlist_imports(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  raw_path TEXT NOT NULL,
  extinf_artist TEXT,
  extinf_title TEXT,
  extinf_duration_seconds INTEGER,
  match_type TEXT NOT NULL CHECK (match_type IN ('path', 'metadata', 'missing')),
  matched_node_id INTEGER REFERENCES nodes(id),
  reason TEXT
);

CREATE INDEX playlist_import_entries_import_id_idx ON playlist_import_entries(import_id);
