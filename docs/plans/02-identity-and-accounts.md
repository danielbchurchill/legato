# 02 · Identity & accounts

Gaps: **G25** one identity (severity 4), **G26** relay billing (4), **G27** Apple / email / passkey (3), **G28** device and credential management (3), **G29** export and deletion (3), plus the server-claim half of **G17**. Decisions: D1, D14, D15, D18.

## Current state

- **Two unlinked identity systems.**
  - Home server: `server/src/migrations/0021_users.sql` + `server/src/routes/auth.ts`. Google and GitHub OAuth users plus sessions, and nothing is actually gated behind sign-in.
  - Relay: `relay/src/accounts.ts` with its own `relay_users` / `relay_sessions`.
- **Relay pairing** (`relay/src/pairing.ts`) links a *home server* to a relay account.
  - A signed-in relay user asks for a code: `randomBytes(8)` hex, 16 characters, 10-minute TTL.
  - The server exchanges the code for a tunnel credential (`randomBytes(32)`) that lasts about a year.
  - Rotation is noted in the file as a follow-up.
- **Only logout exists.** There's no account deletion, no export, and no device list.

## Target model

```
legato.fm account ──owns──▶ home server(s) ──local owner (always)──▶ offline login
       │                          │
       ├──sessions per device     ├──guests (invited legato.fm accounts, per-guest scope)
       └──hosted library (free)   └──tunnel credential (rotatable, revocable)
```

- **legato.fm is the identity provider.** Accounts, sign-in methods and sessions live in the relay's service on Fly (it's already the public, always-on piece). Rename things as needed: it becomes "the legato.fm service", with the relay tunnel as one of its jobs.
- **Home servers trust legato.fm with signed tokens.** When a user opens a server through the relay or directly, the client gets a short-lived token from legato.fm for that server, signed with the service's key. The server verifies it against the service's public keys, which it fetches and caches at claim time and refreshes daily. A cached key keeps working offline for signed-in devices until the token expires.
  - **As built in #114:**
    - There is no claim flow yet, so keys aren't fetched at claim time. An unlinked server makes no contact with legato.fm at all, which is the promise on the privacy page. The owner links their account (`POST /api/v1/auth/legato/link`), and that link does the first key fetch. After that the keys refresh daily.
    - Every token carries a `scope`. `access` opens the library. `link` is only accepted by the link endpoint.
    - legato.fm signs `link` only, until it can record which servers an account has linked. Signing `access` for any server id would let a hostile server that claims a real server's public id replay a visitor's token against the real one. That follow-up is #231, and it blocks #117.
- **Every server has a local owner.** Created at first boot, it signs in with a password or passkey stored only on that server. It works with no account and no internet. A server can be claimed to an account later, or never. Nothing the local owner can do today gets gated behind an account, except relay access.
- **Server `users` rows** keep their local primary key and gain `legato_account_id` (nullable). The existing Google/GitHub users are migrated by matching verified email to a legato.fm account, and anything that doesn't match stays local-only.

## Claiming a headless server (G1 + G17)

The desktop app is claimed through its own UI. A headless server shows the code itself:

1. First boot with no owner: the server logs, and serves at `/setup`, a **claim code** `K7QM-4XRD` (8 characters, Crockford base32, no 0/O/1/I/L confusion), a QR code of `https://legato.fm/claim?code=…`, and a live 10-minute countdown.
2. Anyone who opens `/setup` on the LAN with the code, or scans the QR, sets up the local owner. They can also claim the server to their legato.fm account in the same step.
3. **Expired code (H9):** `/setup` shows "that code expired, here's a new one" and issues a fresh code automatically. The terminal logs the new one too. Never make someone restart the container to get a code.
4. Claiming to an account runs today's pairing exchange underneath, just with the new code format. `relay/src/pairing.ts` changes its alphabet and length, and the `pairing_codes` table keeps its shape.

## Devices and credentials (G28)

- Account settings list sessions (device, client, last seen, approximate location from IP at sign-in only) and **servers** (name, last tunnel connection, credential age).
- Revoke a session; revoke a server's tunnel credential (the server shows "disconnected from legato.fm, claim again"); **rotate** a credential without re-claiming (the server fetches the replacement over its current authenticated tunnel).
- Cut the credential lifetime to 90 days with silent rotation, down from about a year.

## Sign-in methods (G27)

Order of work: **passkeys** (WebAuthn, platform authenticators), **emailed sign-in link** (fallback and account recovery; needs a transactional email provider such as Resend or Postmark, chosen in the issue), **Sign in with Apple**. Google and GitHub stay. An account can have several methods, and settings shows which ones are linked.

## Billing (G26)

- Merchant of record: Paddle or Lemon Squeezy. The issue starts with a one-page comparison (fees, payout countries, webhook quality, customer portal) for Daniel to choose from.
- **Only the relay is paid.** Hosted accounts are free (D14).
- The account has a plan state (`free`, `relay_active`, `relay_past_due`, `relay_canceled`), driven by the provider's webhooks and nothing else.
- **Say what canceling does before it happens (H2, H5):** "Your servers keep working at home. Remote access stops on <date>." A canceled relay never touches the server's data.

## Export and deletion (G29)

- **Export:** a zip of account data (profile, sign-in methods minus secrets, playlists, play history held by legato.fm, and the hosted-library SQLite file if there is one). It's generated in the background, and an emailed link is valid for 24 hours.
- **Deletion:** a confirmation screen that lists exactly what will go, a 7-day grace period (so a mistaken deletion can still be undone, H3), then hard deletion including the per-account SQLite file. Claimed servers go back to local-owner-only and keep everything that's stored on them.

## Risks

- Token verification on the home server is security-critical: pin the algorithm (EdDSA), check `aud` = server id, `exp` ≤ 15 minutes, and keep clock-skew tolerance small. Write tests for tampered, expired and wrong-audience tokens.
- Migrating existing server users: run it against a copy of the Pi's real database before shipping.
