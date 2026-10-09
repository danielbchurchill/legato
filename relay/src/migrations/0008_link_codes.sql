-- Linking a home server to an account from its web client (issue #325).
--
-- A page a home server serves can't hold a legato.fm session: the session
-- cookie would be third-party there. So the page sends its owner to
-- GET /link here, with the server's id, the page's address and a PKCE
-- challenge (RFC 7636). Signed in, the owner presses link (POST /link), and
-- that writes one row: a one-time code for this account and that server,
-- bound to the challenge and to the origin the code is sent back to, in the
-- URL fragment. The page then spends the code with its verifier at
-- POST /link/redeem, from that origin, for a `link` token, and its server
-- reports the link as any link is reported (linked-servers.ts). That report,
-- not this code, is what records the pair and mints the tunnel credential,
-- so a code nobody spends leaves nothing behind but this row.
--
-- The same shape as relay_auth_codes (0003), and for the same reasons: only
-- the code's hash is stored, so a copy of relay.db can't finish anyone's
-- link, and used_at spends a code on the first attempt, right verifier or
-- not, inside one transaction. The origin is only ever compared, so it's a
-- hash too: legato.fm keeps no record of a home server's local address.

CREATE TABLE relay_link_codes (
  code_hash TEXT PRIMARY KEY,
  relay_user_id INTEGER NOT NULL REFERENCES relay_users(id) ON DELETE CASCADE,
  server_id TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  return_origin_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE INDEX relay_link_codes_relay_user_id_idx ON relay_link_codes (relay_user_id);
