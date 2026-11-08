-- Issue #359: a track's artist, by the rule an album's artist and the map's
-- clusters already use (#351): its first performed_by credit, by edge id,
-- that is an artist node, past a 'credit' node credited ahead of it.
-- entities/aggregate.ts's trackArtists is where the rule lives, and every
-- recompute writes this column from there, only where the answer changed.
-- The Tracks table, a track's subtitle on the map (routes/nodes.ts) and the
-- layout's seed (layout/seed.ts) read it.
--
-- ON DELETE SET NULL, because nothing that deletes a node knows to clear it
-- first. A merge (match/people.ts's mergeNodeInto) moves it to the survivor
-- like any other column that names a node, and the next recompute decides
-- it again either way.
ALTER TABLE recordings ADD COLUMN artist_node_id INTEGER REFERENCES nodes(id) ON DELETE SET NULL;

-- Filled in here, once, so the Tracks table names its artists from the
-- first start after upgrading rather than from the next scan. The same rule
-- in SQL, as 0042 did for albums; aggregate.ts is still where it lives.
UPDATE recordings
SET artist_node_id = (
  SELECT e.to_node
  FROM edges e
  JOIN nodes a ON a.id = e.to_node AND a.type = 'artist'
  WHERE e.from_node = recordings.node_id AND e.type = 'performed_by'
  ORDER BY e.id
  LIMIT 1
);

-- Lets deleting a node find the tracks that name it.
CREATE INDEX recordings_artist_node_id_idx ON recordings (artist_node_id);
