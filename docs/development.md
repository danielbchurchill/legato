# Development

How to run the pieces of Legato on their own, preview from another machine, and get out of the usual tangles. [AGENTS.md](../AGENTS.md) holds the conventions; this page is the commands.

## The full desktop app

```sh
npx tauri dev
```

That's all you need. It builds the server sidecar the first time (this needs Bun 1.4.2), starts the server from source, and opens the native window with native playback.

## Just the web client, in a browser

```sh
npm run dev:full
```

This starts the standalone server and Vite together, both on loopback. Open the URL Vite prints (`http://localhost:5173` unless that port is taken). Playback works through the server's stream route instead of the Rust engine, so it's real audio but not gapless.

When you're only working on one half:

```sh
npm run dev          # Vite only; needs a server already running
npm run dev:server   # the standalone server only (bun --watch restarts it on changes)
```

A fresh data dir has no owner account. From the same machine, the web client offers to create one without a setup code.

## Previewing from another machine

Plain `npm run dev` binds to loopback, so nothing else can reach it. If both machines are on the same [Tailscale](https://tailscale.com) network:

```sh
npm run dev:remote
```

This binds the server and Vite to the machine's Tailscale IPv4, points the frontend at it, and prints the URL to open from the other machine.

## Running a second copy alongside the first

Only one server can hold port 8899, and Vite moves on to 5174, 5175 and so on when 5173 is taken. That makes it easy for a second checkout's frontend to end up talking to the first checkout's server. Give the second copy its own ports and data dir:

```sh
LEGATO_PORT=8901 LEGATO_DATA_DIR=/tmp/legato-dev npm --prefix server run dev
VITE_SERVER_PORT=8901 npx vite --port 5181 --strictPort
```

## Troubleshooting

**Blank preview, failing API calls, or stale data.** Something else may already be serving on 8899 or 5173: an old run, or another checkout.

```sh
lsof -nP -iTCP:8899 -sTCP:LISTEN
lsof -nP -iTCP:5173 -sTCP:LISTEN
```

Killing the Tauri binary alone doesn't stop its child Vite or server processes. They run in their own process groups on purpose.

**Server changes don't show up.** The server that `npx tauri dev` starts doesn't hot-reload. Restart the app, or use `npm run dev:server`, which does.

**An empty library, or the wrong database.** Set `LEGATO_DATA_DIR` explicitly for a standalone server. Without it, the server opens `~/.local/share/legato/`, which is a different database from the desktop app's. Startup logs the path and the file count.

**`resource path … doesn't exist` from cargo.** The sidecar binary hasn't been built yet. Run `npm run build:sidecar` once, or start with `npx tauri dev`, which does it for you.

**`bun: not found`.** Install Bun 1.4.2: `curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.2"`. If it's already in `~/.bun/bin`, add that directory to your `PATH`.

## Checks and builds

```sh
npm run check:all              # server type check, server tests, vitest, build, lint, sidecar build, cargo test
npm --prefix relay test        # the relay's tests
npm run build                  # web assets only
npx tauri build                # a packaged desktop app, sidecar included
npm --prefix server run compile -- linux-arm64   # a standalone server binary for one target
```

## Platforms

Development happens on Linux and macOS. `.github/workflows/build.yml` builds the desktop app on macOS, Windows and Linux; its artifacts are unsigned installers, so Gatekeeper and SmartScreen will warn. Linux (x64 and arm64) is a main platform for both the app and the server.
