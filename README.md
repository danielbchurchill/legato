# Legato

A local-first music library manager: scans a real music collection, matches and collapses duplicate/variant tracks (MBID → AcoustID → fuzzy), lays the result out as an explorable node graph, enriches it from MusicBrainz/Cover Art Archive/LRCLIB/Deezer/Wikipedia, and plays it back gapless on the desktop.

Three parts:

- **Root** — the Tauri + React desktop app (Vite, TypeScript, Tailwind v4).
- **`server/`** — a standalone Fastify service owning the file scan, SQLite DB, matching, enrichment, hygiene worklist, and tag write-back. Tauri spawns it as a child process; it can also run on its own.
- **`relay/`** — a separate, early-stage service prototyping remote access (letting a phone reach your home server when you're off the LAN). Not wired into the desktop app yet — see [Remote access](#remote-access-relay-prototype) below.

For architecture, conventions, and day-to-day workflow, see [CLAUDE.md](CLAUDE.md). For the visual language, see [DESIGN.md](DESIGN.md). This file is just: how do I get it running.

## Requirements

- Node, pinned in `.nvmrc` — run `nvm use` before anything else.
- [Bun](https://bun.sh/) — `server/` runs on it (issue #100); everything else (root app, `relay/`, `site/`) still runs on Node.
- Rust toolchain, for the Tauri shell (`npx tauri dev` / `npx tauri build`).
- [Tailscale](https://tailscale.com/), only if you're previewing this from a different machine than the one running it (see below).

## Running the full desktop app

```bash
npx tauri dev
```

This alone is enough. It spawns the embedded server itself — no second terminal, no separate `npm run dev`. Native playback, native window, the real thing.

## Running just the web UI, locally

If you don't need the native shell (native menus, gapless Rust playback) and just want the React app in a browser on the same machine — playback still works, via the server's transcode-stream route rather than the Rust engine:

```bash
npm run dev:full
```

This starts the standalone server and Vite together, both bound to loopback. Open the URL Vite prints (`http://localhost:5173` unless something else is already on that port).

Two narrower variants, useful when working on one half only:

```bash
npm run dev          # Vite only — needs a server already running elsewhere
npm run dev:server   # standalone server only (bun --watch, auto-restarts on server code changes)
```

## Previewing from another machine (e.g. through Orca SSH)

If you're driving this machine remotely — Orca on a Mac, SSH'd into this workstation over Tailscale, rather than sitting at it directly — plain `npm run dev` won't reach you: Vite alone only binds to loopback, invisible outside this machine. Use the remote variant instead:

```bash
npm run dev:remote
```

This binds both the server and Vite to this machine's Tailscale IPv4 address instead of `127.0.0.1`, and points the frontend's server calls (`VITE_SERVER_HOST`) at that same address. It prints the URL to open, something like:

```
➜  Network: http://100.x.x.x:5173/
```

From there you have two options:

- **Just open it.** Tailscale already gives your Mac a direct route to that address — paste the printed URL straight into a normal browser tab on the Mac. No agent, no relay, nothing Orca-specific required. This is the plain "preview it myself" path.
- **Have an agent drive it.** From within an Orca session, `orca tab create --url http://100.x.x.x:5173/` opens that URL in a real Chromium tab in your live Orca session, which an agent can then screenshot/click/inspect via `orca screenshot` / `orca snapshot` / `orca click` / `orca eval` — no relaying back to this machine needed. Useful for UI iteration with an agent in the loop; not needed just to look at the page yourself.

Note: `orca computer *` (native window control) is macOS-only and cannot see or drive the actual Tauri window running on this machine's display. The remote path above covers the web UI, including playback — outside Tauri, the app plays back through a plain `<audio>` element against the server's transcode-to-FLAC stream route instead of calling into the Rust engine, so it's real audio, just not gapless, and there's no native device picker (Settings says so plainly rather than showing a control that can't work). Native-only behavior that has no web equivalent at all — real window chrome, native menus — still needs you at this machine directly.

## Remote access (relay prototype)

The app is local-first and stays that way — your library never leaves your machine. `relay/` is an early prototype of the piece that will eventually let your *phone* reach your home server from off your home network, without you managing Tailscale or port-forwarding yourself. It's not wired into the desktop app yet, and there's no real account system — this is the tunnel mechanism only, proven with real tests.

What it does: a home server opens one persistent WebSocket to the relay (`GET /tunnel`, authenticated with a shared secret); a client's HTTP requests to `ALL /relay/*` get forwarded down that tunnel and streamed back, multiplexed by request so several requests can be in flight over one connection at once. It never stores anything but that connection — no audio, no library data.

To run it locally:

```bash
cd relay
npm install
npm test          # 7 real tests — actual WebSocket connections, no mocking
RELAY_SHARED_SECRET=dev npm start
```

**Explicitly not there yet:** real multi-account relay auth (today's shared secret is a stand-in), any pairing UX in the app itself, and any actual deployment. This is groundwork for the eventual paid remote-access tier, not something you can point your phone at today — for that, see the Tailscale-based remote preview above, which already works.

## Troubleshooting

**Preview loads blank, or API calls fail, or you're seeing stale data.** Check whether a dev server is already running — either from an earlier session you forgot about, or from a *different* worktree of this repo:

```bash
ps aux | grep -E "bun --watch|vite"
```

The standalone server binds `0.0.0.0:8899` with no override by default, and Vite binds one address (loopback for `dev`, this machine's Tailscale IP for `dev:remote`). If you run more than one Legato worktree at once (e.g. `~/dev/legato` and `~/dev/legato-chromis`), **only one server can hold port 8899**, and Vite will silently auto-increment past a taken `5173` to `5174`, `5175`, etc. — so a second worktree's frontend can end up pointed at nothing (server startup failed) or, worse, at the *first* worktree's server and its data. Don't assume a broken preview means broken code — check for a leftover process first.

If you find one you don't recognize, it may be another live session's active work — don't kill it without checking. To run this worktree's server in isolation, on its own port, without touching anyone else's:

```bash
LEGATO_PORT=8901 LEGATO_DATA_DIR="$HOME/.local/share/fm.legato.app" bun --watch src/index.ts   # from server/
```

**Server changes aren't showing up.** The *embedded* server (the one Tauri spawns) does not hot-reload — it's a plain `bun src/index.ts` child with no watch mode. Any change to `server/` needs the whole app restarted when running via `npx tauri dev`. `npm run dev:server` (standalone, via `bun --watch`) does auto-restart on change — use that when iterating on server code alone.

**Standalone server can't find your library / opens an empty database.** Set `LEGATO_DATA_DIR` explicitly. Tauri sets this automatically to its per-OS app-data directory; a bare `npm --prefix server run dev` without it falls back to `~/.local/share/legato/` — a second, empty database next to your real one:

```bash
LEGATO_DATA_DIR=~/.local/share/fm.legato.app npm --prefix server run dev
```

Startup logs the resolved DB path and file count, so a wrong path is a one-line diagnosis.

## Testing & linting

```bash
npm run lint            # oxlint (root)
npm --prefix server test    # bun test, server-side (scan/match/layout/facts/enrich/hygiene/tagwrite/cover)
```

## Building

```bash
npm run build       # tsc -b && vite build — web assets only
npx tauri build      # full native desktop build
```

## Platform support

Primary development happens on Linux, but `.github/workflows/build.yml` builds and tests this app for real on **macOS, Windows, and Linux** on every push — not just claimed, actually run: [latest results](https://github.com/danielbchurchill/legato/actions/workflows/build.yml). A green run produces real unsigned installers you can download from that run's Artifacts: `.dmg`/`.app` (macOS), `.msi`/`.exe` via NSIS (Windows), `.AppImage`/`.deb`/`.rpm` (Linux).

**What that CI run does and doesn't prove.** It proves the Rust shell and frontend genuinely compile and pass `server`'s test suite on all three platforms — real, not assumed (it already caught and fixed one macOS-only bug this way, a `cpal`/CoreAudio thread-safety issue invisible on Linux and Windows). It does **not** yet prove the packaged app *runs* correctly end-to-end for someone who just installs it: the embedded server still launches via `bun src/index.ts` from source, which means it currently assumes Bun is installed on whatever machine runs it. That's fine for development; it's not yet true "install and go" for macOS/Windows users — that's what compiling the server to a self-contained binary (issue #102) is for. No code signing or notarization either — Gatekeeper/SmartScreen will warn on an unsigned build, expected for now.
