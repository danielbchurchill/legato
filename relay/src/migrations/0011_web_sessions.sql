-- A web client signs in to legato.fm (issue #365).
--
-- A page a home server serves, at whatever origin that is, can't hold
-- legato.fm's session cookie (it would be third-party there), and can't be
-- trusted with a session for the whole account: a page is whatever its
-- server sends, and a hostile server's page could name another server's
-- id. So it comes to /connect with a statement its own server signed
-- (server/src/auth/serverKey.ts, webClientStatement), and leaves with a
-- one-time code. Spending that code, from that origin, buys a session for
-- that one server.
--
-- relay_link_codes keeps #325's codes and these, told apart by kind. A
-- connect code's server_id is the server that vouched for the page.
--
-- relay_sessions gains the session's scope. server_id is null for every
-- session before this one, and for every browser and desktop sign-in: the
-- whole account. A web session has the one server it may reach, and the
-- origin it was issued to, kept as an HMAC as relay_link_codes keeps
-- origins (keyed from the signing secret, never on the volume), so relay.db
-- alone can't say where a home server is. The relay's CORS looks a request's
-- Origin up by that HMAC: an origin with a live web session is one of
-- Legato's own client origins (routes/relay.ts).

ALTER TABLE relay_link_codes ADD COLUMN kind TEXT NOT NULL DEFAULT 'link' CHECK (kind IN ('link', 'connect'));

ALTER TABLE relay_sessions ADD COLUMN server_id TEXT;
ALTER TABLE relay_sessions ADD COLUMN origin_mac TEXT;

CREATE INDEX relay_sessions_origin_mac_idx ON relay_sessions (origin_mac) WHERE origin_mac IS NOT NULL;
