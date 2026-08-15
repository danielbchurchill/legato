-- Caches each recording's similarity feature vector (server/src/similarity/
-- features.ts) rather than caching pairwise scores directly — pairwise
-- caching for N recordings is O(N^2) rows for what's a trivial O(N) cosine
-- scan at query time against a real library's recording count. Recomputed
-- wholesale after every scan (same idiom as entities/aggregate.ts and
-- entities/collaboration.ts), which is what "invalidate on re-scan" means
-- here: there's no partial invalidation to get wrong because there's no
-- partial state — a stale vector never survives a recompute pass.
--
-- vector_json is a plain JSON array rather than fixed numeric columns: its
-- length depends on the current library's vocabulary (distinct genres,
-- artists, labels, release types), which changes as the library grows, and
-- every vector is always rebuilt together in one pass, so two vectors
-- compared at query time are always from the same feature space by
-- construction.
CREATE TABLE node_similarity_features (
  node_id INTEGER PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  vector_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
