-- Issue #302: an album's artist is now the one the map clusters it under
-- (src/canvas/clusters.ts), which is also who the Library's Artists tab and
-- header count as having records of their own. entities/aggregate.ts
-- decides it at every recompute: each track with a file votes for its first
-- performed_by credit, by edge id, that is an artist node; each release goes
-- to whoever most of its tracks voted for, ties to the lower id; a node that
-- isn't a release gets no artist.
--
-- Nothing recomputes on upgrade, so without this every albums row would
-- keep the old rule's answer (the first performed_by credit whatever it
-- pointed at, votes from recordings with no file, an artist for any node a
-- hand-drawn appears_on reaches) until the next rescan. The tab and the
-- header would disagree with the map until then. This is the same rule in
-- SQL, applied once to the rows already there. aggregate.ts is still where
-- the rule lives, and each recompute writes it from there.
--
-- The rest of each row (track count, duration, years) didn't change.
CREATE TEMP TABLE album_artist_0042 (
  album INTEGER PRIMARY KEY,
  artist INTEGER NOT NULL
);

WITH first_credit AS (
  SELECT recording, artist
  FROM (
    SELECT e.from_node AS recording, e.to_node AS artist,
           ROW_NUMBER() OVER (PARTITION BY e.from_node ORDER BY e.id) AS position
    FROM edges e
    JOIN nodes r ON r.id = e.from_node AND r.type = 'recording'
    JOIN nodes a ON a.id = e.to_node AND a.type = 'artist'
    WHERE e.type = 'performed_by'
      AND EXISTS (SELECT 1 FROM files f WHERE f.recording_node_id = e.from_node)
  )
  WHERE position = 1
),
votes AS (
  SELECT ao.to_node AS album, fc.artist AS artist, COUNT(*) AS votes
  FROM edges ao
  JOIN first_credit fc ON fc.recording = ao.from_node
  JOIN nodes release ON release.id = ao.to_node AND release.type = 'release'
  WHERE ao.type = 'appears_on'
  GROUP BY ao.to_node, fc.artist
)
INSERT INTO album_artist_0042 (album, artist)
SELECT album, artist
FROM (
  SELECT album, artist, ROW_NUMBER() OVER (PARTITION BY album ORDER BY votes DESC, artist ASC) AS position
  FROM votes
)
WHERE position = 1;

-- Only the rows whose answer changed, so updated_at still says when each
-- row last moved.
UPDATE albums
SET primary_artist_node_id = (SELECT artist FROM album_artist_0042 WHERE album = albums.node_id),
    updated_at = datetime('now')
WHERE primary_artist_node_id IS NOT (SELECT artist FROM album_artist_0042 WHERE album = albums.node_id);

DROP TABLE album_artist_0042;
