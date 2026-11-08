-- Issues #383 and #359: what the Tracks table names and sorts each track by,
-- stored on its recordings row, and the indexes its sorts walk.
--
-- At 30,000 albums the table has 300,000 tracks. Worked out from the edges
-- and files on every read, a page took 0.2 to 3.4 s depending on the sort,
-- and a search 4 to 6 s, because every row cost several lookups before the
-- sort or the filter could start. entities/aggregate.ts's recomputeEntities
-- writes these at every recompute, only where the answer changed:
--
--  - artist_node_id: the track's artist, by the rule an album's artist and
--    the map's clusters already use (#351, #359): its first performed_by
--    credit, by edge id, that is an artist node, past a 'credit' node
--    credited ahead of it. A track's subtitle on the map (routes/nodes.ts)
--    and the layout's seed (layout/seed.ts) read it too.
--  - album_node_id: its first appears_on edge, by id, to a release node.
--  - format: its first file's format, by file id.
--
-- ON DELETE SET NULL, because nothing that deletes a node knows to clear
-- these first. A merge (match/people.ts's mergeNodeInto) moves them to the
-- survivor like any other column that names a node, and the next recompute
-- decides them again either way.
ALTER TABLE recordings ADD COLUMN artist_node_id INTEGER REFERENCES nodes(id) ON DELETE SET NULL;
ALTER TABLE recordings ADD COLUMN album_node_id INTEGER REFERENCES nodes(id) ON DELETE SET NULL;
ALTER TABLE recordings ADD COLUMN format TEXT;

-- Filled in here, once, so the Tracks table names and sorts its tracks from
-- the first start after upgrading rather than from the next scan. The same
-- rules in SQL, as 0042 did for albums; aggregate.ts is still where they
-- live.
UPDATE recordings
SET artist_node_id = (
      SELECT e.to_node
      FROM edges e
      JOIN nodes a ON a.id = e.to_node AND a.type = 'artist'
      WHERE e.from_node = recordings.node_id AND e.type = 'performed_by'
      ORDER BY e.id
      LIMIT 1
    ),
    album_node_id = (
      SELECT e.to_node
      FROM edges e
      JOIN nodes a ON a.id = e.to_node AND a.type = 'release'
      WHERE e.from_node = recordings.node_id AND e.type = 'appears_on'
      ORDER BY e.id
      LIMIT 1
    ),
    format = (SELECT f.format FROM files f WHERE f.recording_node_id = recordings.node_id ORDER BY f.id LIMIT 1);

-- A sort by artist or album walks the artists or albums in title order
-- (nodes_type_title_idx) and each one's tracks in id order, so it reads only
-- as far as the page it's asked for. These also let deleting a node find
-- the tracks that name it.
CREATE INDEX recordings_artist_node_id_idx ON recordings (artist_node_id);
CREATE INDEX recordings_album_node_id_idx ON recordings (album_node_id);
CREATE INDEX recordings_format_idx ON recordings (format);
CREATE INDEX recordings_canonical_duration_ms_idx ON recordings (canonical_duration_ms);

-- The title and date-added sorts, and the artist and album sorts' order.
-- type comes first because every one of them is one type's nodes.
CREATE INDEX nodes_type_title_idx ON nodes (type, title);
CREATE INDEX nodes_type_created_at_idx ON nodes (type, created_at);

-- The albums page's recently played sort (routes/library.ts) takes each
-- track's last play from this alone, without reading the plays themselves.
-- It begins with the column the index it replaces held, so every query that
-- used that one can use this.
CREATE INDEX plays_recording_node_id_started_at_idx ON plays (recording_node_id, started_at);
DROP INDEX plays_recording_node_id_idx;

-- Then each played track's albums, from the index alone. Through
-- edges_from_node_idx it read every edge the track has to find them, which
-- was half the sort's time.
CREATE INDEX edges_appears_on_from_node_idx ON edges (from_node, to_node) WHERE type = 'appears_on';
