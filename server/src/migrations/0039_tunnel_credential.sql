-- Issue #237: the credential this server's tunnel connects to legato.fm
-- with, once someone has claimed the server from its /setup page and its
-- owner linked that account (auth/claim.ts). legato.fm mints it when the
-- server reports that link, bound to this server's id (relay migration
-- 0006), and nothing else ever hands one out. #310 opens the tunnel with it;
-- until then nothing reads it. #115 lists, revokes and rotates it.
--
-- One row: one tunnel, for the account that claimed the server. Claiming
-- it again replaces the row. origin is the legato.fm that issued it, so a
-- server pointed at another LEGATO_ID_ORIGIN later doesn't offer it there.
--
-- A secret, like server_identity.private_key (0037): no route returns it,
-- nothing logs it, and it isn't in `settings`. The pre-migration backups in
-- <data dir>/backups/ hold it once it exists, as they hold the key.
CREATE TABLE tunnel_credential (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  origin TEXT NOT NULL,
  account_id TEXT NOT NULL,
  credential TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  stored_at TEXT NOT NULL DEFAULT (datetime('now'))
);
