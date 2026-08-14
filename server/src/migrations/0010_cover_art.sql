-- Cover art lives on disk, not in SQLite. A single embedded cover is routinely
-- a multi-megabyte JPEG, serving one means streaming a file regardless, and a
-- blob column would bloat every backup of a database that is otherwise tiny.
-- This table is the index over that on-disk cache; server/src/cover/store.ts
-- owns the cache itself.
--
-- Art attaches to a node — normally a 'release', falling back to the
-- 'recording' for loose files with no album tag. Several sources can coexist
-- for one node (a folder cover.jpg *and* embedded art *and* a manual
-- override). Precedence is resolved at read time by resolveCover() rather than
-- by maintaining an is_active flag, so adding an override wins immediately and
-- there is no denormalised state that can drift.
CREATE TABLE cover_art (
  id INTEGER PRIMARY KEY,
  node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('embedded', 'folder', 'caa', 'manual')),
  -- sha1 of the *original* bytes, before resizing. Doubles as the cache key,
  -- so two albums sharing one cover image store one copy on disk.
  hash TEXT NOT NULL,
  mime TEXT,
  -- Provenance, so a later pass can tell "this came from a file we no longer
  -- have" from "the user chose this deliberately".
  origin_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
  origin_path TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per (node, source): re-scanning a file replaces that node's embedded
-- art instead of accumulating a duplicate every time its mtime changes.
CREATE UNIQUE INDEX cover_art_node_source ON cover_art (node_id, source);

-- Reverse lookup for cache eviction: which rows still reference a given blob.
CREATE INDEX cover_art_hash ON cover_art (hash);
