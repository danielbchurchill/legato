-- Issue #465: an album is no longer found by its ALBUM tag alone. A disc
-- suffix made "Farewells & Fantasies (disc 1)" and "(disc 2)" two albums,
-- and two artists' "Greatest Hits" shared one node. match/albumIdentity.ts
-- now says which album a file is on: its title without the disc suffix, by
-- its ALBUMARTIST when it has one, and in its folder when it doesn't.
--
-- An album node can be reached by more than one such key: by its artist,
-- and by the folder its files are in, which is how a track missing the
-- ALBUMARTIST tag its neighbours have still lands on their album
-- (match/releases.ts). So the keys get a table of their own rather than a
-- column on nodes. The foreign key is what has match/people.ts's
-- mergeNodeInto carry an album's keys to the node it's merged into, as it
-- does every other row that names a node.
CREATE TABLE release_keys (
  key TEXT PRIMARY KEY,
  node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE
);

CREATE INDEX release_keys_node_id_idx ON release_keys (node_id);
