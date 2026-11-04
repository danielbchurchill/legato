-- A collection's cover is a 2×2 mosaic of up to four of its albums (#462).
-- Which four is a stable pseudo-random pick that cover/mosaic.ts makes from
-- the albums alone. These rows keep which cell each of the four sits in,
-- so that when an album leaves (its last track removed, merged away,
-- deleted from the library) only its own cell changes: no pure function of
-- the album set can promise that, since two removals in either order end
-- at the same albums with the newcomers in different cells.
--
-- No foreign key to nodes, on purpose: a merge (match/people.ts) would
-- carry an album's id onto the survivor, which may already have a cell.
-- An id that's no longer one of the collection's albums is simply refilled
-- the next time the mosaic is read. Existing collections get their cells
-- the first time they're read, from the same pick.
CREATE TABLE playlist_mosaic_cells (
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  cell INTEGER NOT NULL CHECK (cell BETWEEN 0 AND 3),
  node_id INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, cell)
);

-- The favourites are one collection, so one mosaic.
CREATE TABLE favourites_mosaic_cells (
  cell INTEGER PRIMARY KEY CHECK (cell BETWEEN 0 AND 3),
  node_id INTEGER NOT NULL
);
