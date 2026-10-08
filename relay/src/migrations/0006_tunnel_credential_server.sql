-- Issue #237: which home server each tunnel credential belongs to.
--
-- A headless server is claimed from its /setup page: an account claims the
-- code that page shows (POST /pair/claim), and the server redeems it at
-- POST /pair/exchange. Holding the code doesn't prove you're the server
-- showing it, so the exchange also carries a signature from the server's
-- identity key (linked-servers.ts, server migration 0037), and the
-- credential it mints is bound to the id that key hashes to. #310's tunnel
-- can then tell which server a connection claims to be, and #115 can list
-- and revoke credentials per server.
--
-- NULL for a credential minted before this, which no server holds: no home
-- server had a tunnel client to redeem one with.
ALTER TABLE tunnel_credentials ADD COLUMN server_id TEXT;

CREATE INDEX tunnel_credentials_server_id_idx ON tunnel_credentials (server_id);
