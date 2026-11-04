-- Issue #464: an edit made from the details panel is one tag write per file
-- (0009's tag_writes), and an album or an artist is many files. This groups
-- them, and keeps what the edit does to the node itself: an artist's new
-- name, or an album's new title or album artist. tagwrite/rename.ts carries
-- the node over when the first of its writes is approved, and back when the
-- last one is reverted.
--
-- node_id follows the node through a merge: match/people.ts's mergeNodeInto
-- moves every column that references nodes, read from the schema's own
-- foreign keys.
CREATE TABLE tag_edits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id INTEGER REFERENCES nodes(id) ON DELETE SET NULL,
  old_title TEXT,
  new_title TEXT,
  old_album_artist TEXT,
  new_album_artist TEXT,
  -- What approving did to the node: 'renamed' it in place, or 'merged' it
  -- into the node that already had the name. NULL until then, and again
  -- once every file is reverted and a rename has been undone.
  applied TEXT CHECK (applied IN ('renamed', 'merged')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE tag_writes ADD COLUMN edit_id INTEGER REFERENCES tag_edits(id) ON DELETE SET NULL;

CREATE INDEX tag_writes_edit_id_idx ON tag_writes(edit_id);
