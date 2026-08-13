-- Search-as-you-type for the manual-edge target picker (M5). External-
-- content FTS5 table over nodes.title, kept in sync via triggers rather
-- than duplicating title storage.
CREATE VIRTUAL TABLE nodes_fts USING fts5(title, content='nodes', content_rowid='id');

INSERT INTO nodes_fts(rowid, title) SELECT id, title FROM nodes;

CREATE TRIGGER nodes_fts_ai AFTER INSERT ON nodes BEGIN
  INSERT INTO nodes_fts(rowid, title) VALUES (new.id, new.title);
END;

CREATE TRIGGER nodes_fts_ad AFTER DELETE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, title) VALUES('delete', old.id, old.title);
END;

CREATE TRIGGER nodes_fts_au AFTER UPDATE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, title) VALUES('delete', old.id, old.title);
  INSERT INTO nodes_fts(rowid, title) VALUES (new.id, new.title);
END;
