-- Pairing codes and tunnel credentials — the two-step handoff that lets a
-- home server (a headless process with no browser, no relay session
-- cookie of its own) authenticate its tunnel without ever seeing the
-- relay account's OAuth session directly.
--
-- Step 1 (POST /pair/start, needs a real relay session): the signed-in
-- account mints a pairing_codes row — short-lived, single-use. The code
-- itself is the only thing that crosses the trust boundary from "browser
-- with a session" to "headless home server with none".
--
-- Step 2 (POST /pair/exchange, needs only the code): the home server
-- redeems the code for a tunnel_credentials row — long-lived, the
-- permanent secret it sends in the tunnel's `auth` frame from then on
-- (routes/tunnel.ts), replacing the old single global RELAY_SHARED_SECRET.
-- used_at marks a pairing code spent; redemption runs in one transaction
-- (see pairing.ts) so a code can't be raced into minting two credentials.
--
-- Both tables index their lookup column (code / token) as the primary
-- key on purpose — auth and redemption resolve a caller's identity by a
-- direct indexed lookup, never a linear scan over every stored value.

CREATE TABLE pairing_codes (
  code TEXT PRIMARY KEY,
  relay_user_id INTEGER NOT NULL REFERENCES relay_users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE INDEX pairing_codes_relay_user_id_idx ON pairing_codes (relay_user_id);

CREATE TABLE tunnel_credentials (
  token TEXT PRIMARY KEY,
  relay_user_id INTEGER NOT NULL REFERENCES relay_users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE INDEX tunnel_credentials_relay_user_id_idx ON tunnel_credentials (relay_user_id);
