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
