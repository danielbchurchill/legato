-- Issue #310: when legato.fm last heard from each home server's tunnel, so
-- an account's "your servers" (GET /linked-servers) can say "offline since
-- …" for a server whose tunnel isn't connected. Whether it's connected now
-- is the relay's own in-memory registry (tunnel-registry.ts); this row is
-- what survives a relay restart.
--
-- last_seen_at moves when a tunnel authenticates, on every heartbeat while
-- it stays up (routes/tunnel.ts), and when it closes. The heartbeat keeps it
-- close to the truth even when the relay itself stops without closing
-- anything.
--
-- Keyed by server id, like the registry, not by account: one server has one
-- tunnel, whichever accounts have linked it. No foreign key, for the reason
-- in 0005: there's no servers table.
CREATE TABLE server_tunnels (
  server_id TEXT PRIMARY KEY,
  last_seen_at TEXT NOT NULL
);
