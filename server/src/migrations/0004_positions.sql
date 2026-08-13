CREATE TABLE positions (
  node_id INTEGER PRIMARY KEY REFERENCES nodes(id),
  seed_x REAL NOT NULL,
  seed_y REAL NOT NULL,
  seed_version INTEGER NOT NULL DEFAULT 1,
  user_x REAL,
  user_y REAL
);
