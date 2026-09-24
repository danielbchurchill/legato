# 03 · Connection & streaming

Gaps: **G12** adaptive bitrate (severity 4), **G17** client connection (4), **G18** connection-path indicator (3), **G19** invites and guests (3), **G30** server-unreachable state (3). Decisions: D1, D8, D13.

## Current state

- `src/config/serverHost.ts`: `SERVER_HOST = import.meta.env.VITE_SERVER_HOST ?? '127.0.0.1'`, **fixed at build time**. One frontend build can only ever talk to one server.
- The server doesn't serve the frontend. There's no static route in `server/src/index.ts`.
- `GET /api/v1/files/:id/stream` transcodes to FLAC only, with a cache in `server/src/stream/cache.ts`.
- The relay tunnels HTTP/WS to claimed servers. Clients reach it today only when the build is pointed at it.
- No mDNS, no guests, no roles. The `users` table exists and nothing is gated.

## Web client served by the home server + runtime host

A prerequisite for the installable web app (G16) and the hosted client (G10):

- The server serves the built frontend (`dist/`, embedded in the compiled binary) at `/`, with an SPA fallback. Opening `http://<server>:8899/` from any browser *is* the client.
- **The host is resolved at runtime, not build time:** use the page's own origin when served by a server; the configured endpoint in the desktop app; the chosen server when on `app.legato.fm`. `serverHost.ts` stays the one place this lives, but becomes a function or store instead of a constant. `VITE_SERVER_HOST` keeps working as a dev override.

## Connecting a client (G17 client half, G18)

**Connect screen** for the desktop app, installable web app, and `app.legato.fm`:

1. **Servers on this network:** found through mDNS (`_legato._tcp`, advertised by the server with name, id and version). One tap connects, then local owner or account sign-in.
2. **Your servers:** signed in to legato.fm, it lists claimed servers and marks each as *reachable at home* / *through the relay* / *offline since …*.
3. **Custom address:** for Rowan's own domain or Tailscale IP. Validated immediately, with specific errors: DNS failure, refused, TLS problem, "that's not a Legato server".

**Connection-path indicator (H1):** a small, always-visible status in the shell showing `home network` / `relay` / `custom`, plus the current stream quality. Hovering or tapping explains it. Rowan can pin a path ("never use the relay") in settings.

## Server unreachable (G30)

A server that drops out mid-session gets a real state, not a spinner (H1, H9):
- *what happened:* "Can't reach Priya's MacBook"
- *likely why:* asleep / offline / network changed, inferred from the last-seen time and the path that failed
- *one action:* "Try again". On macOS, the desktop app can also offer "Keep this Mac awake while serving" (see [07](07-clients.md)).

Playback carries on from any tracks already buffered. The queue and position survive reconnecting.

## Quality ladder (G12)

| Path | Default | Choices |
|---|---|---|
| Home network | Original (FLAC passthrough if the source is FLAC, otherwise original container) | Original, Opus 256 |
| Relay | Opus 160 | Opus 96 / 160 / 256, Original |
| Custom endpoint | Opus 256 | all |
| Safari / iOS web | AAC 256 instead of Opus 256, AAC 160 instead of Opus 160 | |

- The stream route gains `?quality=original|opus96|opus160|opus256|aac160|aac256`. The cache key includes quality, and `server/src/maintenance/` cache sweeping covers every variant.
- The client picks from the connection path plus any user override, and shows the result in the connection indicator. Choosing quality per track is enough: a mid-track network drop pauses the track and moves the *next* track down a level. No HLS (D13).
- Native desktop playback on the same machine keeps reading files directly and never transcodes.
- **Time-to-first-audio matters most** (Jordan: "if it buffers, I'm gone"). Stream the transcode while it's being written instead of waiting for the file to finish. Target under one second on the relay for Opus 160.

## Invites and guests (G19)

- The owner creates an invite link (single use or N uses, expiry, scope). The guest signs in with legato.fm, or makes an account inside the invite flow.
- Scope per guest: **shared playlists only (default)** / whole library. Guests can never write tags, change settings, or see other guests.
- Server routes gain role checks: `owner`, `guest`. Every route must default to owner-only, and guest access is added deliberately, route by route. Write tests.
- Owner settings list guests with scope, last played, and a revoke button.
- When a guest invite ends (revoked or expired), the guest sees a calm explanation, and for Jordan that's one of the nudge points ([08](08-jordan-and-spotify.md)).
