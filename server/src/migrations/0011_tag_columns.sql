-- track_no/disc_no/year were already parsed by normalizeTags (scan/tags.ts)
-- but only ever landed in the tags_raw JSON blob, making them unqueryable —
-- the metadata panel and the entity aggregates in 0012 both need real
-- columns to sort/filter/group on. release_date/bpm/label/release_type/genre
-- are tags music-metadata already exposes that nothing has read at all yet.
-- genre is stored as a JSON array (a track can carry more than one) to match
-- tags_raw's existing convention rather than inventing a join table for v1.
ALTER TABLE files ADD COLUMN track_no INTEGER;
ALTER TABLE files ADD COLUMN disc_no INTEGER;
ALTER TABLE files ADD COLUMN release_date TEXT;
ALTER TABLE files ADD COLUMN bpm REAL;
ALTER TABLE files ADD COLUMN label TEXT;
ALTER TABLE files ADD COLUMN release_type TEXT;
ALTER TABLE files ADD COLUMN genre TEXT;

-- Backfill from tags_raw for every file already scanned — no re-scan needed
-- for anything normalizeTags already parsed (track_no/disc_no). The four
-- newly-read fields (release_date/bpm/label/release_type/genre) stay NULL
-- here since tags_raw never carried them; they populate on the next re-scan
-- of each file.
UPDATE files SET
  track_no = CAST(json_extract(tags_raw, '$.trackNo') AS INTEGER),
  disc_no = CAST(json_extract(tags_raw, '$.discNo') AS INTEGER)
WHERE tags_raw IS NOT NULL;
