-- Relay-side account provisioning — a separate identity system from
-- server/'s users table (server/src/migrations/0021_users.sql). server/'s
-- users answer "does this client get to talk to THIS home server install";
-- relay_users answers "which relay account owns which home server's
-- tunnel" — a real multi-tenant mapping, since more than one Legato user
-- will eventually have a paired home server routing through the same
-- deployed relay. Shape otherwise mirrors server/'s users/sessions tables
-- deliberately, down to the (provider, provider_user_id) upsert key and
-- the real revocable sessions table — see accounts.ts and
-- routes/auth.ts.

CREATE TABLE relay_users (
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

-- A real table, not a JWT — same rationale as server/'s sessions table:
-- revocation is a DELETE, not an unsolved problem. id doubles as the
-- bearer token (a random 32-byte hex string minted in accounts.ts).
CREATE TABLE relay_sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES relay_users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE INDEX relay_sessions_user_id_idx ON relay_sessions (user_id);
