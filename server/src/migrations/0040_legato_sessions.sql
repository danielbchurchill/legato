-- Issue #117: a client that signs in to this server with legato.fm swaps a
-- ten-minute `access` token for a session at POST /auth/legato/session, so
-- covers and audio get a media ticket like any other session.
--
-- legato_account_id marks such a session, with the legato.fm account it came
-- from. It doesn't slide (auth/sessions.ts skips the refresh for it) and
-- lasts a fixed LEGATO_SESSION_TTL_HOURS, because legato.fm stops signing
-- access tokens the moment an account revokes or unlinks, and a 30-day
-- sliding session would outlive that by a month. Unlinking the account here,
-- or linking another one in its place, deletes its sessions at once.
-- Password and owner sessions keep NULL and behave exactly as before.
ALTER TABLE sessions ADD COLUMN legato_account_id TEXT;

CREATE INDEX sessions_legato_account_id_idx ON sessions (legato_account_id) WHERE legato_account_id IS NOT NULL;

-- Each access token is exchanged once. Its jti goes in here, so a captured
-- token can't be turned into a second, longer-lived session. A row is no use
-- once its token has expired (the gate refuses the token itself by then), so
-- rows past expires_at are pruned on the next exchange.
CREATE TABLE spent_access_tokens (
  jti TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
);
