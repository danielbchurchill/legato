-- #133: Apple Music's play counts, ratings and date added, imported from
-- the Library.xml Music writes (applemusic/import.ts).
--
-- A play count comes in as one total per track, never as that many made-up
-- plays: a plays row with source 'apple-music' whose play_count is Music's
-- total for the track, and whose started_at is Music's "Play Date UTC", or
-- '' when Music has a count but no date. Every play Legato records itself
-- stays a row of its own, and the default makes every existing row the
-- one play it always was. A constant default needs no table rebuild.
--
-- Readers count SUM(play_count), never rows, and read the time through
-- NULLIF(started_at, ''), both from playCounts.ts. A re-import deletes every
-- 'apple-music' row and writes the new totals in one transaction, so it
-- replaces Music's numbers rather than adding to them, and leaves Legato's
-- own plays alone. Music's own count never includes those.
ALTER TABLE plays ADD COLUMN play_count INTEGER NOT NULL DEFAULT 1;

-- What else Music knows about a track, keyed by the file it was matched
-- to, one row per source. Nothing reads these yet. rating is Music's own
-- 0-100 scale (20 a star), and only a rating set on the track itself: one
-- Music worked out from an album rating ("Rating Computed") isn't kept.
-- date_added is Music's "Date Added", an ISO time. Like the totals, a
-- re-import replaces a source's rows.
CREATE TABLE imported_track_facts (
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  rating INTEGER,
  date_added TEXT,
  imported_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (file_id, source)
);

-- Which playlist in the source an import came from ('apple-music:' and
-- Music's "Playlist Persistent ID"), so importing the same Library.xml
-- again leaves a playlist already brought over as it is, edits included,
-- rather than adding a second copy. Null for an .m3u import, which has no
-- such id.
ALTER TABLE playlist_imports ADD COLUMN source_key TEXT;
CREATE INDEX playlist_imports_source_key_idx ON playlist_imports(source_key) WHERE source_key IS NOT NULL;
