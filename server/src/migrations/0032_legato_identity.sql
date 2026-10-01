-- Issue #114 (plan 02, Target model): legato.fm becomes the identity
-- provider, and this server trusts the short-lived EdDSA tokens it signs.
--
-- users.legato_account_id is the legato.fm account a row belongs to: the
-- token's `sub`, kept as opaque TEXT because it's legato.fm's id, not ours.
-- NULL means local-only, which is every row on upgrade. The local owner is
-- linked explicitly (POST /api/v1/auth/legato/link); a Google/GitHub row
-- from before 0029 is linked on first contact instead, when a token
-- arrives whose verified email matches exactly one of them
-- (auth/legatoUsers.ts). That match can't run here: the accounts live on
-- legato.fm, and a migration has no network. The partial unique index
-- keeps it one account, one row.
ALTER TABLE users ADD COLUMN legato_account_id TEXT;
CREATE UNIQUE INDEX users_legato_account_id ON users (legato_account_id) WHERE legato_account_id IS NOT NULL;

-- One row. server_id is this server's audience: a token is only accepted
-- here if its `aud` is this value. 128 random bits, made once, on upgrade,
-- with nobody at a terminal. It's public (GET /auth/status), so it only
-- has to be unique, not secret.
--
-- jwks is legato.fm's public signing keys as last fetched, so a restart
-- while offline still verifies. NULL until this server is linked to a
-- legato.fm account: an unlinked server never contacts legato.fm at all
-- (legato.fm/privacy). Not in `settings` on purpose: PUT /settings writes
-- whatever key it's sent, and a signed-in user who could replace these
-- keys could sign their own tokens as the owner.
CREATE TABLE server_identity (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  server_id TEXT NOT NULL,
  jwks TEXT,
  jwks_fetched_at TEXT
);

INSERT INTO server_identity (id, server_id) VALUES (1, lower(hex(randomblob(16))));
