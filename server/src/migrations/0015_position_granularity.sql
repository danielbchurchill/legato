-- Session 4 splits the graph into three independently-navigable
-- granularities (artists/albums/tracks), each with its own layout — an
-- artist node's seed position in the artists graph (a collaboration-
-- cluster centroid) has nothing to do with its centroid position in the
-- tracks graph. positions needs a second key dimension to hold up to
-- three rows per node instead of one. SQLite can't ALTER a PRIMARY KEY,
-- so this is the same rebuild-and-swap 0014 used for enrich_jobs' CHECK
-- constraint.
--
-- Every existing row is exactly a 'tracks'-granularity position (the only
-- graph that existed before this migration), so the backfill is a literal
-- copy, not a recomputation — the next scan (or a manual trigger) computes
-- the other two granularities for the first time.
CREATE TABLE positions_new (
  node_id INTEGER NOT NULL REFERENCES nodes(id),
  granularity TEXT NOT NULL DEFAULT 'tracks' CHECK (granularity IN ('artists', 'albums', 'tracks')),
  seed_x REAL NOT NULL,
  seed_y REAL NOT NULL,
  seed_version INTEGER NOT NULL DEFAULT 1,
  user_x REAL,
  user_y REAL,
  PRIMARY KEY (node_id, granularity)
);

INSERT INTO positions_new (node_id, granularity, seed_x, seed_y, seed_version, user_x, user_y)
  SELECT node_id, 'tracks', seed_x, seed_y, seed_version, user_x, user_y FROM positions;

DROP TABLE positions;
ALTER TABLE positions_new RENAME TO positions;
