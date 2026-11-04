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

-- Merging one node into another (match/people.ts's mergeNodeInto) moves
-- every row that names it, and deleting the old node has SQLite check every
-- column that could still name it. These two had no index, so each merge
-- read both tables whole three times: about 115 ms a merge on a
-- 30,000-album library, which the start below would spend on every disc
-- part it merges. With them it's a few milliseconds.
CREATE INDEX files_fuzzy_candidate_node_id_idx ON files (fuzzy_candidate_node_id);
CREATE INDEX recordings_work_node_id_idx ON recordings (work_node_id);

-- The albums already in a library have no keys, and the way they're split
-- and merged has to change: disc parts become one album, and a node two
-- artists' albums share becomes two. That needs each file's tags and path
-- read through the rule above, which SQL can't do, so it happens once at
-- the next start (match/releaseUpgrade.ts, called from index.ts). This row
-- says it's still owed. A database with no albums yet has nothing to bring
-- forward, and every album it gets is keyed as it's made.
CREATE TABLE release_identity_upgrade (
  id INTEGER PRIMARY KEY CHECK (id = 1)
);

INSERT INTO release_identity_upgrade (id) SELECT 1 WHERE EXISTS (SELECT 1 FROM nodes WHERE type = 'release');
