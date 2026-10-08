import type { Database } from "../sqlite.js";

// The credential this server's tunnel connects to legato.fm with (issue
// #237, migration 0039). legato.fm hands it over only when the server
// reports a link that came from a claim (auth/legatoLink.ts), so it's here
// only once the owner has linked the account that claimed the server.
// Nothing connects with it yet: that's #310, which reads it with
// readTunnelCredential.

export type StoredTunnelCredential = { origin: string; accountId: string; credential: string; expiresAt: string };

export function storeTunnelCredential(db: Database, stored: StoredTunnelCredential): void {
  db.prepare(
    `INSERT INTO tunnel_credential (id, origin, account_id, credential, expires_at) VALUES (1, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET origin = excluded.origin, account_id = excluded.account_id,
       credential = excluded.credential, expires_at = excluded.expires_at, stored_at = datetime('now')`,
  ).run(stored.origin, stored.accountId, stored.credential, stored.expiresAt);
}

// Only for the legato.fm that issued it: a server pointed at another
// LEGATO_ID_ORIGIN has no credential there.
export function readTunnelCredential(db: Database, origin: string): StoredTunnelCredential | null {
  const row = db
    .prepare("SELECT origin, account_id, credential, expires_at FROM tunnel_credential WHERE id = 1 AND origin = ?")
    .get(origin) as { origin: string; account_id: string; credential: string; expires_at: string } | undefined;
  return row ? { origin: row.origin, accountId: row.account_id, credential: row.credential, expiresAt: row.expires_at } : null;
}
