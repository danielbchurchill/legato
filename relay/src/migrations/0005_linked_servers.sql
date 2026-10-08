-- Issue #231: which home servers each legato.fm account has linked. One
-- row is one pair, "this account has linked this server", and it's what
-- POST /auth/server-token checks before it signs an `access` token. Every
-- other server gets `link` only (routes/auth.ts has the reason).
--
-- A row is written only when the server itself proves it owns server_id
-- (linked-servers.ts). A server's id is the first 128 bits of SHA-256 over
-- its Ed25519 public key (server migration 0037), so the proof is that
-- key's signature, and public_key is the key that made it. It's kept so a
-- client can later check that whatever answers as this server holds the
-- key (#117). It's public, like the id.
--
-- No foreign key on server_id: there's no servers table. A server is
-- known to legato.fm only through the accounts that linked it.
CREATE TABLE linked_servers (
  relay_user_id INTEGER NOT NULL REFERENCES relay_users(id) ON DELETE CASCADE,
  server_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  linked_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (relay_user_id, server_id)
);

CREATE INDEX linked_servers_server_id_idx ON linked_servers (server_id);

-- Each proof works once. A link proof is spent by its link token's jti, and
-- an unlink proof that removes a pair by the nonce the server put in it.
-- An unlink proof that removes nothing writes nothing (linked-servers.ts).
-- Without this, a copy of a link proof could re-create a pair its owner had
-- just removed, for as long as the token inside it lasts. A row is only
-- needed until its proof would be refused as expired anyway, so expired
-- rows are pruned on the next insert.
CREATE TABLE spent_server_proofs (
  proof_id TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
);
