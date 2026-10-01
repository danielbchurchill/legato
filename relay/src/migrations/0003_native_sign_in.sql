-- Handing a browser sign-in back to the desktop app (issue #215): OAuth
-- for native apps (RFC 8252) with PKCE (RFC 7636). The provider still
-- calls back to the relay's own /auth/<provider>/callback; the loopback
-- redirect is the relay's second hop, after that.
--
-- relay_native_requests carries a native sign-in across the provider round
-- trip. GET /auth/<provider> with a code_challenge and a loopback
-- redirect_uri writes one row, keyed by the SHA-256 of the same random
-- `state` the relay_oauth_state cookie holds; the callback looks it up by
-- that state and deletes it, so a request is used at most once.
--
-- relay_auth_codes holds the one-time code the callback sends to the
-- loopback listener. POST /auth/token spends it (used_at) on the first
-- attempt, right verifier or not, inside one transaction, so two racing
-- redemptions can't both mint a session.
--
-- Hashes only: neither the state nor the code is stored raw, so a copy of
-- relay.db can't finish anyone's sign-in. code_challenge is stored as
-- given; it's already a hash of the app's verifier, which never reaches
-- the relay until redemption and is never stored at all.

CREATE TABLE relay_native_requests (
  state_hash TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'github')),
  code_challenge TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE relay_auth_codes (
  code_hash TEXT PRIMARY KEY,
  relay_user_id INTEGER NOT NULL REFERENCES relay_users(id) ON DELETE CASCADE,
  code_challenge TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE INDEX relay_auth_codes_relay_user_id_idx ON relay_auth_codes (relay_user_id);
