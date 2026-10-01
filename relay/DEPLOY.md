# Deploying relay/ to Fly.io

This is a real runbook, not general Fly.io documentation. It assumes:

- A Fly.io account exists.
- The `fly` CLI is installed locally.
- `fly auth login` has already been run locally.

Run all commands from this directory (`relay/`) unless noted otherwise.

**Live deployment against a real Fly account has not been exercised yet.**
Everything below is config that has been reviewed and (where possible)
built locally, not a deploy that has actually succeeded end to end. Treat
the first real run of these steps as the actual test of this setup.

As of the Bun migration (issue #101), `docker build .` and a local
`docker run` against a throwaway data dir both succeed — the image boots,
`GET /health` returns `{"status":"ok"}`, and `RELAY_DATA_DIR` gets a real
`relay.db` (WAL mode, migrations applied). `fly deploy` itself has not been
run; that, and confirming the deployed machine passes the same checks
against the real `legato-relay` app, is still the actual test of this
runbook end to end.

## 1. Create the app

```
fly apps create legato-relay
```

`legato-relay` may already be taken. If it is, pick a different name, then
edit the `app` field at the top of `fly.toml` to match before continuing —
every command below assumes `--app` matches that field.

## 2. Create and attach the persistent volume

The relay needs durable storage at `RELAY_DATA_DIR` (`/data` in `fly.toml`)
for the SQLite database the relay-accounts workstream is adding. Create one
volume in the same region as `primary_region` in `fly.toml`:

```
fly volumes create relay_data --region iad --size 1 --app legato-relay
```

`fly.toml` already declares the mount (`[[mounts]] source = "relay_data"`,
`destination = "/data"`) — no further wiring needed once the volume exists.

If you deploy into more than one region, create a volume per region; Fly
volumes are region-local.

## 3. Set secrets

There is no static tunnel secret to set — home servers authenticate with a
per-account credential minted through the pairing flow (`POST /pair/exchange`),
not a fixed value. What this relay does need is its own OAuth app registration
(separate from `server/`'s local-server OAuth apps — same providers, different
callback URL, different client id/secret; see `relay/.env.local.example` for
the full contract):

```
fly secrets set \
  RELAY_GOOGLE_CLIENT_ID="<value>" \
  RELAY_GOOGLE_CLIENT_SECRET="<value>" \
  RELAY_GITHUB_CLIENT_ID="<value>" \
  RELAY_GITHUB_CLIENT_SECRET="<value>" \
  RELAY_AUTH_CALLBACK_BASE_URL="https://<this app's real domain>" \
  --app legato-relay
```

Without these set, `/auth/*` and `/pair/*` 503 with a clear "not configured"
message rather than failing to boot — see `relay/src/routes/auth.ts`. The
relay proxy itself (`/tunnel`, `/relay/*`) works with none of this configured,
since tunnel auth is credential-based, not OAuth-gated.

### Token signing key (issue #114)

legato.fm signs short-lived tokens that home servers verify against
`GET /.well-known/jwks.json`. The key is a secret, never a file on the volume,
which holds `relay.db` and its snapshots:

```
bun relay/scripts/generate-signing-key.ts      # prints {"privateKey":"…"}, and the kid on stderr
fly secrets set RELAY_SIGNING_KEYS='[<that entry>]' --app legato-relay
```

Without it the relay still boots: the JWKS is `{"keys":[]}` and
`POST /auth/server-token` 503s naming the variable. A malformed value is
treated the same way, with one error line at startup.

Rotating: append a new entry second (published, not yet signing), wait more
than a day so every linked server's daily refresh has it, move it first, and
remove the old one 15 minutes later. The steps are also in
`relay/src/signing-keys.ts`.

## 4. Deploy

```
fly deploy --app legato-relay
```

## 5. Verify

```
fly status --app legato-relay
curl https://legato-relay.fly.dev/health
```

The curl should return `{"status":"ok"}`. In `fly status`, confirm at least
one machine is running — `min_machines_running = 1` in `fly.toml` means it
should never show zero.

## Notes

- This relay holds long-lived WebSocket tunnels from connected home
  servers. Do not enable Fly's scale-to-zero / auto-stop-on-idle behavior —
  it would silently drop every connected tunnel. `fly.toml` already sets
  `auto_stop_machines = false` and `min_machines_running = 1`; if you ever
  edit `fly.toml`, keep both.
- `RELAY_DATA_DIR` is set in `fly.toml` and read by `relay/src/config.ts` —
  `relay/src/db.ts` stores the relay's SQLite database (accounts, sessions,
  pairing codes, tunnel credentials) at `$RELAY_DATA_DIR/relay.db`.
- The runtime image is `oven/bun:1.4.2-slim`, not a Node image — `relay/`
  runs on Bun (issue #101), the same adapter pattern `server/` uses
  (`relay/src/sqlite.ts` wraps `bun:sqlite`). Dependencies still install
  via `npm ci` in a separate `node:24.19.0-slim` build stage, since
  `package-lock.json` stays the source of truth for exact versions and
  Debian's own `npm` apt package drags in an unrelated dependency tree;
  only the runtime stage and `CMD` (`bun src/index.ts`) changed.
