import type { Database } from "../sqlite.js";

// The credential this server's tunnel connects to legato.fm with (issue
// #237, migration 0039). legato.fm hands it over only when the server
// reports a link (auth/legatoLink.ts), from a claim or, since issue #325,
// from Settings, so it's here only once the owner has linked an account.
// The tunnel (issue #310, tunnel/relayTunnel.ts) connects with it, and
// unlinking that account forgets it.

export type StoredTunnelCredential = { origin: string; accountId: string; credential: string; expiresAt: string };

// A link's credential (auth/legatoLink.ts) replaces everything, a
// rotation's previous one included.
export function storeTunnelCredential(db: Database, stored: StoredTunnelCredential): void {
  db.prepare(
    `INSERT INTO tunnel_credential (id, origin, account_id, credential, expires_at) VALUES (1, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET origin = excluded.origin, account_id = excluded.account_id,
       credential = excluded.credential, expires_at = excluded.expires_at, stored_at = datetime('now'),
       previous_credential = NULL, previous_expires_at = NULL`,
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

// Only the given account's: the row may already hold a newer account's
// credential when an owner links a different account.
export function forgetTunnelCredential(db: Database, accountId: string): boolean {
  return db.prepare("DELETE FROM tunnel_credential WHERE id = 1 AND account_id = ?").run(accountId).changes > 0;
}

// Rotation (issue #115, tunnel/relayTunnel.ts, migration 0044). A
// replacement is stored over `current`, which is kept as the previous one
// until legato.fm accepts the replacement: legato.fm retires the old one
// only once the new one is used, and if it refuses the new one, the old
// one is what still works. Only over `current` itself, for the same
// legato.fm and account: an unlink or a link since has stored something
// else. A previous one already kept stays: it's the last one legato.fm
// accepted, and the replacement it was waiting on never was.
export function replaceTunnelCredential(
  db: Database,
  current: Omit<StoredTunnelCredential, "expiresAt">,
  replacement: { credential: string; expiresAt: string },
): boolean {
  return (
    db
      .prepare(
        `UPDATE tunnel_credential SET credential = ?, expires_at = ?, stored_at = datetime('now'),
           previous_credential = COALESCE(previous_credential, credential),
           previous_expires_at = CASE WHEN previous_credential IS NULL THEN expires_at ELSE previous_expires_at END
         WHERE id = 1 AND origin = ? AND account_id = ? AND credential = ?`,
      )
      .run(replacement.credential, replacement.expiresAt, current.origin, current.accountId, current.credential).changes > 0
  );
}

export function previousTunnelCredential(db: Database, origin: string): { credential: string; expiresAt: string } | null {
  const row = db
    .prepare("SELECT previous_credential, previous_expires_at FROM tunnel_credential WHERE id = 1 AND origin = ?")
    .get(origin) as { previous_credential: string | null; previous_expires_at: string | null } | undefined;
  return row?.previous_credential && row.previous_expires_at
    ? { credential: row.previous_credential, expiresAt: row.previous_expires_at }
    : null;
}

// legato.fm accepted `credential`, and retired every one before it: the
// previous one has no use left.
export function forgetPreviousTunnelCredential(db: Database, credential: string): void {
  db.prepare(
    "UPDATE tunnel_credential SET previous_credential = NULL, previous_expires_at = NULL WHERE id = 1 AND credential = ? AND previous_credential IS NOT NULL",
  ).run(credential);
}

// legato.fm refused `refused`, a replacement it never accepted: the
// previous one goes back in its place. Null when there's none to go back
// to, or something else has been stored since.
export function restorePreviousTunnelCredential(db: Database, refused: string): { credential: string; expiresAt: string } | null {
  const row = db
    .prepare(
      `UPDATE tunnel_credential SET credential = previous_credential, expires_at = previous_expires_at, stored_at = datetime('now'),
         previous_credential = NULL, previous_expires_at = NULL
       WHERE id = 1 AND credential = ? AND previous_credential IS NOT NULL AND previous_expires_at IS NOT NULL
       RETURNING credential, expires_at`,
    )
    .get(refused) as { credential: string; expires_at: string } | undefined;
  return row ? { credential: row.credential, expiresAt: row.expires_at } : null;
}
