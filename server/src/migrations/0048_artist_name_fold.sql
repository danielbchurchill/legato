-- Issue #466: "The Traveling Wilburys" from the tags and "Traveling
-- Wilburys" from a MusicBrainz band-membership answer were two artist nodes.
-- Artist lookups now ignore a leading "The" (match/artistLookup.ts), and
-- the duplicates already made are folded together once, at the first start
-- after this migration (match/artistFold.ts). This row says whether that
-- has happened. folded_at is NULL until it has.
--
-- Not in `settings`, for the reason 0043 gives: PUT /settings writes
-- whatever key it's sent and GET /settings returns them all.
CREATE TABLE artist_name_fold (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  folded_at TEXT
);

INSERT INTO artist_name_fold (id) VALUES (1);

-- A band-membership answer names each artist with its MusicBrainz id, and
-- the lookup finds the artist node holding that id first. Only artist ids
-- are looked up by value, so only they are indexed. The query has to say
-- `field = 'artist_mbid'` for SQLite to use a partial index.
CREATE INDEX field_provenance_artist_mbid_idx ON field_provenance (value) WHERE field = 'artist_mbid';
