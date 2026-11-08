-- Issue #322: similarity vectors, stored sparsely.
--
-- 0016 stored each vector as a JSON array as long as the library's whole
-- vocabulary (every genre, artist, artist cluster, label and release type),
-- almost all of it zeros: about 9 KB a row, 3 GB at 30,000 albums. A new
-- genre or artist moved every position after it, so a recompute that
-- widened the vocabulary rewrote every row.
--
-- A vector is now only its non-zero entries, packed into a BLOB
-- (similarity/vectors.ts), each against a dimension from
-- similarity_dimensions. A dimension is a feature's own key ("artist:123",
-- "genre:rock") with an id that never changes, so a vocabulary that grows
-- leaves the vectors already stored as they were.
--
-- The dense rows can't be converted here: a position means nothing without
-- the vocabulary it was built against, and that was never stored. So they
-- go, and the next recompute writes every vector again. index.ts starts one
-- on the first start after this, unless another recompute is starting then
-- anyway. similarity_state.version stays 0 until a recompute has written
-- vectors, and goes up by one each time one changes them, which is how the
-- request loop knows its copy in memory is out of date
-- (similarity/similarity.ts).
DROP TABLE node_similarity_features;

CREATE TABLE node_similarity_features (
  node_id INTEGER PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  vector BLOB NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE similarity_dimensions (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE
);

CREATE TABLE similarity_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL
);

INSERT INTO similarity_state (id, version) VALUES (1, 0);
