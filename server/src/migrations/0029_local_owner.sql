-- Issue #112 (D1): every server gets a local owner, and every route now
-- requires a signed-in user. 0021 described these tables as "provisioning
-- plumbing, not an access-control system" — this migration is where that
-- stops being true, so both tables change shape.
--
-- users gains:
--   * provider 'local' — the owner's own password account, stored only on
--     this server and usable with no internet and no legato.fm account.
--   * password_hash — Bun.password's argon2id PHC string (auth/owner.ts).
--     Required for 'local' rows, forbidden on OAuth rows, so a Google user
--     can never also be signed into with a password nobody set.
--   * role — 'owner' is the local owner; 'legacy' is every Google/GitHub
--     user that existed before this migration. The gate treats both as
--     full access until the identity migration (#114) maps them onto
--     legato.fm accounts. New OAuth identities are no longer created at
--     all (routes/auth.ts), because once a users row grants access,
--     "anyone with a Google account gets a row" would mean anyone with a
--     Google account gets in.
--
-- SQLite has no ALTER … CHECK, so this is the rebuild-and-swap 0014 and
-- 0019 use. sessions holds the only foreign key into users, and it is
-- rebuilt below anyway, so it goes first: dropping users with foreign_keys
-- on would otherwise cascade into it mid-swap.
DROP TABLE sessions;

CREATE TABLE users_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL CHECK (provider IN ('local', 'google', 'github')),
  provider_user_id TEXT NOT NULL,
  email TEXT,
  display_name TEXT,
  avatar_url TEXT,
  password_hash TEXT,
  role TEXT NOT NULL CHECK (role IN ('owner', 'legacy')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (provider, provider_user_id),
  CHECK ((provider = 'local') = (password_hash IS NOT NULL))
);

INSERT INTO users_new (id, provider, provider_user_id, email, display_name, avatar_url, role, created_at, last_login_at)
  SELECT id, provider, provider_user_id, email, display_name, avatar_url, 'legacy', created_at, last_login_at
  FROM users;

DROP TABLE users;
ALTER TABLE users_new RENAME TO users;

-- One owner per server, enforced by the database rather than by a
-- SELECT-then-INSERT in the route: two first-run requests racing each
-- other can't both win, whatever order they land in.
CREATE UNIQUE INDEX users_one_owner ON users (role) WHERE role = 'owner';

-- Sessions are now keyed by the SHA-256 of their token, not the token
-- itself, so a copied legato.db (a backup, the VACUUM INTO copy #191
-- takes before every migration) holds nothing that signs anyone in. The
-- old rows used the raw token as the key and can't be converted without
-- the tokens themselves, so they are dropped: a Google/GitHub user signs
-- in once more, nothing else is lost.
--
-- media_ticket_hash is a second, read-only credential per session for
-- URLs that can't carry an Authorization header — <img>, <audio>, the
-- WebSocket (auth/gate.ts). Stable for the session's life so cover URLs
-- stay cacheable, and it dies with the session row.
--
-- expires_at slides: auth/sessions.ts pushes it forward on use, at most
-- once a day, so a device used daily is never signed out.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  media_ticket_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  refreshed_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE INDEX sessions_user_id_idx ON sessions (user_id);
