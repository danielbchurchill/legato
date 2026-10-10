-- Issue #115: the tunnel credential a rotation replaced, kept until
-- legato.fm accepts its replacement (tunnel/relayTunnel.ts). legato.fm
-- retires the old one only when the new one is first used, so until it
-- answers that use, the old one may be the only one that works: a
-- legato.fm whose database was restored from before the rotation knows
-- only the old one. If the new one is refused, the server goes back to
-- this, after a restart as well. legato.fm's acceptance clears it, and so
-- does a link storing a credential of its own.
--
-- As secret as credential (0039).
ALTER TABLE tunnel_credential ADD COLUMN previous_credential TEXT;
ALTER TABLE tunnel_credential ADD COLUMN previous_expires_at TEXT;
