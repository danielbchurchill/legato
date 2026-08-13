-- User-authored prose layered on top of generated facts (Legato.md's data
-- model). Nothing writes to this yet — no authoring UI exists — but the
-- article response shape (GET /nodes/:id) already has a place for it.
CREATE TABLE articles (
  node_id INTEGER PRIMARY KEY REFERENCES nodes(id),
  body_md TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
