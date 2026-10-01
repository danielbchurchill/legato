-- Rough OAuth account provisioning (M-?, unscheduled — see auth.ts). Legato
-- is still single-user/local-first: nothing in the app is gated behind
-- these tables, they just give a signed-in identity somewhere real to live
-- once the LAN/remote/mobile server story needs one.
--
-- One row per (provider, external id) — the same account signing in again
-- is an UPSERT, not a new row, which is the whole reason the unique
-- constraint is on the pair rather than on email: email can be null (GitHub
-- doesn't hand one back unless it's public) and, if it ever fires, should
-- read as "this person happens to use the same address on both services",
-- not "these are the same account".
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'github')),
  provider_user_id TEXT NOT NULL,
  email TEXT,
  display_name TEXT,
  avatar_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (provider, provider_user_id)
);

-- A real table, not a JWT: AGENTS.md's own description of this database is
-- "real, SQLite-backed, not aspirational", and the concrete win a sessions
-- table has over a signed token is that revocation is a DELETE instead of
-- an unsolved problem. id doubles as the bearer token (a random 32-byte hex
-- string minted in auth.ts) — there's no separate opaque primary key,
-- because nothing ever looks a session up except by the token a browser
-- cookie hands back.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE INDEX sessions_user_id_idx ON sessions (user_id);
