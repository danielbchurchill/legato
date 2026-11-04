-- Issue #466: a band-membership answer names each artist with its
-- MusicBrainz id, and the lookup (match/artistLookup.ts) finds the artist
-- node holding that id first. Only artist ids are looked up by value, so
-- only they are indexed. The query has to say `field = 'artist_mbid'` for
-- SQLite to use a partial index.
CREATE INDEX field_provenance_artist_mbid_idx ON field_provenance (value) WHERE field = 'artist_mbid';
