-- Issue #272: the artist photo job (enrich/worker.ts, processArtistImageLookup)
-- used to record a skipped lookup, for an artist tag naming more than one
-- artist, as a null 'mbid' provenance row on the artist node. The hygiene
-- worklist reads every node whose latest 'mbid' row is null as a track
-- MusicBrainz couldn't match, so each skip showed up there as a card with
-- nothing to do: 397 of 498 items on a real library.
--
-- The job no longer writes that row; its done enrich_jobs row is the record.
-- This removes the ones already written. Only artist nodes, and only null
-- values: nothing else writes an 'mbid' row on an artist, and recordings
-- keep their whole match history.
DELETE FROM field_provenance
WHERE field = 'mbid'
  AND value IS NULL
  AND node_id IN (SELECT id FROM nodes WHERE type = 'artist');
