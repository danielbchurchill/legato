# Gap-closure plan

This plan turns the 30 gaps (G1–G30) found by the persona and journey work into issues coding agents can pick up. The source is the Figma file [Legato — Personas & UX Journeys](https://www.figma.com/design/xw26F52SViCZptggBFBBBP). Its page 07 is the gap backlog, and every gap was checked against the repo at `f8e806d`.

Each workstream doc explains *why* its work looks the way it does. The GitHub issues say *what* to build and link back to these docs, so they can stay short. If an issue and a doc disagree, the doc wins. Fix the issue.

## Personas and order

| | Persona | Launch order | What they need most |
|---|---|---|---|
| A | Rowan: home server, Synology/Debian, ~180k FLAC tracks | **1st** | Headless install, a scan that respects a huge library, remote access on their own terms |
| B | Priya: Apple Music library on an Intel or Apple Silicon MacBook, iPhone first | **2nd** | Zero configuration, signed builds, light mode, "your Mac is asleep" states |
| C | Jordan: Spotify only, any browser, bad wi-fi | **3rd** | Hosted, browser-first, no install, never buffers |

The beta includes all three (Daniel has testers lined up for each). The phases below set the order work lands, not who gets to test.

## Decisions (settled with Daniel, 2026-09-23)

| # | Decision | Rationale | Rejected |
|---|---|---|---|
| D1 | **legato.fm is the identity provider.** Home servers trust its sessions. Every server also keeps a **local owner** login that works with no account and no internet. | Paying relay users need a central account anyway, and so does a hosted web client. The local owner answers Rowan's "why does self-hosted need an account?" | Per-server users only; linking the two existing tables |
| D2 | **Server runtime moves to Bun and compiles to one binary** (`bun build --compile`), using x64 `-baseline` builds. | Unblocks a Node-free headless install (G1) *and* a signed desktop app (G9). Today Tauri spawns `npm` (`src-tauri/src/server_process.rs:66`), so a packaged app needs Node on the user's machine. Baseline builds cover pre-AVX2 CPUs (Synology J4125, older Intel Macs). | Node single-executable (native addons are its weak point); bundled Node runtime folder (works, but Daniel wants it done right from the start) |
| D3 | **Targets:** linux-x64, linux-arm64, darwin-arm64, **darwin-x64** (a Priya tester is on Intel), windows-x64. | | |
| D4 | **Install channels at beta:** Docker (+ Synology Container Manager guide) → Unraid template → `curl \| sh` install script (systemd user service) → Homebrew tap (launchd). Later: apt repo, TrueNAS/CasaOS, winget. | The Rowan tester runs Synology, and Container Manager takes a compose file directly. | Synology SPK packages |
| D5 | **Updates are notify-only.** The UI says an update is available and shows the right command for how the server was installed. | Home-server people want to decide when their server restarts, especially mid-scan. Self-updating fights Docker and apt. | Self-update with rollback |
| D6 | **Jordan's path is a sequence of steps:** guest on a friend's server → free hosted metadata-only account → own server (the desktop app serving in the background) with the relay. Nudges appear only at natural pauses, never as modals. | Jordan needs easing into owning music. They have no owned files, so there's no in-between "owned files" step. | Hosted music locker at launch (to be tested later); Bandcamp import (Jordan has never used Bandcamp) |
| D7 | **Spotify: metadata import only** (playlists, saved tracks, taste), matched against sources the user can actually play, plus "open in Spotify". The Web Playback SDK is a possible later launch feature, gated on a Spotify developer terms review. | | |
| D8 | **Guests:** the host chooses per guest; the default is shared playlists only. | Keeps it clearly private sharing between people who know each other. | |
| D9 | **Mobile:** installable web app first, Tauri 2 mobile later. | The web app unblocks Jordan and gives Rowan an Android client early. iOS background audio under Tauri needs a spike first. | React Native, native Swift/Kotlin |
| D10 | **Light mode ships at launch**, as a full second theme: warm paper (off-white, *not* yellow) and pen-ink black, "sheet music in colour and contrast". Then dark / light / follow system. Palette designed in Figma first. | Priya and Jordan both expect it. The black wordmark already exists (`src/assets/brand/black-wordmark.svg`). | |
| D11 | **A non-map library view ships** (album grid + track table). | Every music app is expected to have one, even if we don't market it. Amends DESIGN.md's "the graph is the application". | |
| D12 | **Shuffle belongs to each queue; it is never a global setting.** Repeat cycles off → all → one. | Starting an album always plays it in order, which fixes Priya's "shuffle turned itself on". | Global toggles |
| D13 | **Streaming quality:** one file per quality level (original FLAC on LAN; Opus 96/160/256 over the relay, default 160; AAC for Safari/iOS), picked automatically from the connection path, with a user override. | Tracks are short, so choosing quality per track is enough for beta. | HLS adaptive streaming |
| D14 | **Billing:** merchant of record (Paddle or Lemon Squeezy). Only the relay costs money; hosted accounts are free. | A solo developer shouldn't be registering for VAT in every country. The free hosted account is the start of Jordan's path. | Stripe |
| D15 | **Sign-in:** passkeys + emailed sign-in link + Sign in with Apple, keeping Google/GitHub. | Apple becomes mandatory once an iOS app offers other sign-in options (App Store guideline 4.8). | |
| D16 | **Hosted accounts run on Fly.io next to the relay, with one SQLite database per account**, running the same server code with no audio roots. | Reuses the whole server. Per-account files make export and deletion (G29) a file operation. | Shared Postgres |
| D17 | **Scan:** pause/resume survives restarts (a checkpoint per stage); cancel keeps what's already indexed. | | Throw away partial scans |
| D18 | **Server claim code:** 8 characters, Crockford base32, shown as `K7QM-4XRD`, with a QR code and a visible 10-minute countdown. | Today's code is 16 hex characters (`relay/src/pairing.ts:24`), which is painful to type on a phone or TV. | |
| D19 | **Map settings:** three presets named by how they look (clusters / balanced / sprawl), plain-language labels, session undo, restore defaults. | | |

**Still open:** the Synology tester's exact model. The plan assumes an x86 "+" model. A "j" or ARM model has no Container Manager, and the Synology install path would need a rethink.

## Workstreams

| Doc | Covers |
|---|---|
| [01 · Server distribution](01-server-distribution.md) | Bun migration, compile, sidecar, Docker/Synology, install script, Homebrew, update notices, low-power hosts. G1, G9 (partly) |
| [02 · Identity & accounts](02-identity-and-accounts.md) | legato.fm identity, local owner, server claim, devices, sign-in methods, billing, export/delete. G17 (claim), G25–G29 |
| [03 · Connection & streaming](03-connection-and-streaming.md) | Web client served by the home server, runtime host, LAN discovery, connection indicator, unreachable state, quality ladder, guests. G12, G17, G18, G19, G30 |
| [04 · Library & scan](04-library-and-scan.md) | Server-side folder picker, scan stages/ETA/pause, watcher fallback, Synology junk dirs, imports, playback test, tag write-back. G2–G6, G13, G21 |
| [05 · Listening & map](05-listening-and-map.md) | Shuffle/repeat, library view, map presets, saved views, map-to-playlist. G7, G20, G22–G24 |
| [06 · Light mode](06-light-mode.md) | Paper palette, theme tokens, switcher. G8 |
| [07 · Clients](07-clients.md) | Installable web app, signed desktop builds, keep-serving tray, media keys, hosted web client, mobile later. G9, G10, G14–G16 |
| [08 · Jordan's path & Spotify](08-jordan-and-spotify.md) | Hosted metadata-only accounts, Spotify import, source matching, nudges. G10, G11 |

## Phases

**Phase 0: foundations.** Everything packaging and theming depends on: the Bun migration, the compiled binary, the Tauri sidecar, the two small bugs found during planning, and the light-mode palette design.

**Phase 1: Rowan beta.** Headless install on Synology/Docker, server claim, local owner + legato.fm identity, server-side folder picker, scan stages, quality ladder, installable web app (Rowan's Android client until mobile lands), library view, shuffle/repeat, map presets, M3U import.

**Phase 2: Priya beta.** Signed and notarized builds (arm64 + x64 Mac, Windows), keep-serving tray, media keys, library auto-detect, Apple Music import, light mode, passkeys/Apple sign-in, relay billing, playback test, ALAC/AAC/MP3 tag writes.

**Phase 3: Jordan beta.** Hosted accounts, hosted web client, Spotify import and source matching, guests, export/delete, saved views, map-to-playlist, nudges.

**Later:** Tauri mobile (Android, then iOS with offline downloads), Spotify Web Playback SDK (after the terms review), a hosted-locker experiment, apt/TrueNAS/CasaOS/winget, artist and genre lists.

## How agents should work these issues

- Each issue names its gap(s), its heuristics, and a **done when** list. Anything not in the **done when** list is out of scope for that issue.
- Follow CLAUDE.md and DESIGN.md. Any UI work reads DESIGN.md first.
- An issue with a *Depends on* line isn't ready until those issues are closed.
- [waves.md](waves.md) sets which ready issues are worked on together, and [scripts/orchestration/worker-rules.md](../../scripts/orchestration/worker-rules.md) holds the rules every worker's spec includes.
- New failure states follow H9: say what happened, why, and offer one action that fixes it. New long-running operations follow H1: stage, rate, and time remaining, where each is knowable.

## Issue map

Labels: `phase:*`, `area:*`, `sev:2|3|4`. Every issue links back to its section in these docs.

### Phase 0 · foundations · tracking #152

| # | Issue | Sev |
|---|---|---|
| #98 | Route every ffmpeg spawn through FFMPEG_PATH | 3 |
| #99 | Skip Synology/NAS junk folders (@eaDir, #recycle, …) in the scanner and watcher | 3 |
| #100 | Migrate the server runtime from Node/tsx to Bun | 4 |
| #101 | Migrate the relay to Bun | 2 |
| #102 | Compile the server to a single binary for five targets, with a release workflow | 4 |
| #103 | Run the compiled server as a Tauri sidecar instead of npm | 4 |
| #104 | Design the light-mode "paper" palette in Figma | 3 |
| #179 | Make the server port configurable in the frontend | 2 |
| #187 | Sidecar build checks for Bun first and says how to install it | 2 |
| #188 | `build.yml` installs Bun and server deps for the sidecar build | 3 |
| #191 | Back up the database automatically before applying migrations | 4 |
| #194 | One-command deploy of the compiled server to a standalone host | 2 |

### Phase 1 · Rowan · tracking #153

| # | Issue | Sev |
|---|---|---|
| #105 | Multi-arch Docker image and compose file, with a read-only library mount | 3 |
| #106 | Synology Container Manager install guide | 3 |
| #107 | Unraid Community Applications template | 2 |
| #108 | `curl \| sh` install script with a systemd user service | 3 |
| #109 | Homebrew tap with a launchd service | 2 |
| #110 | Update-available notice (notify only) | 2 |
| #111 | Shared concurrency limit for ffmpeg, fingerprinting and cover work | 3 |
| #112 | Local owner account on every server | 4 |
| #113 | Claim a headless server: setup page, 8-character code, QR, countdown | 4 |
| #114 | legato.fm as the identity provider; home servers verify signed tokens | 4 |
| #115 | Devices and tunnel credentials: list, revoke, rotate | 3 |
| #116 | Serve the web client from the home server; resolve the API host at runtime | 4 |
| #117 | Connect screen: servers on this network (mDNS), your servers, custom address | 4 |
| #118 | Connection-path indicator and pinned path | 3 |
| #119 | Server-unreachable state | 3 |
| #120 | Quality ladder: original on LAN, Opus 96/160/256 over the relay, AAC for Safari | 4 |
| #121 | Server-side folder picker | 4 |
| #122 | Detect file-watch limit exhaustion and fall back to periodic rescans | 3 |
| #123 | Scan stages, rate and ETA, with pause/resume/cancel that survive restarts | 3 |
| #124 | M3U/M3U8 playlist import with path remap and match reports | 3 |
| #125 | Shuffle per queue; repeat off / all / one | 3 |
| #126 | Library view: album grid and track table | 3 |
| #127 | Map presets, plain-language labels, undo, restore defaults | 3 |
| #128 | Installable web app: manifest, shell-only service worker, Media Session | 2 |
| #184 | Show an error when native playback can't open a file | 3 |
| #185 | Native client falls back to the server stream when a file isn't reachable | 3 |
| #186 | Run `queue_set_repeat` through `serialized()` | 2 |
| #189 | Collapse, layout and enrich_queued scan stages scale linearly | 3 |
| #192 | Don't mark the whole library missing when its drive or mount isn't reachable | 4 |
| #193 | Report server version in /health and warn when the client needs a newer server | 3 |

### Phase 2 · Priya · tracking #154

| # | Issue | Sev |
|---|---|---|
| #129 | Signed and notarized desktop builds (macOS arm64 + x64, Windows) with the Tauri updater | 4 |
| #130 | Keep serving when the window closes: tray, launch at login, keep-awake | 3 |
| #131 | Native media keys and Now Playing (macOS, Windows, Linux) | 3 |
| #132 | Library auto-detect on first run | 3 |
| #133 | Apple Music library and playlist import, with cloud-only detection | 3 |
| #134 | Playback test step with a live signal-path readout | 2 |
| #135 | Tag write-back for MP4 (ALAC/AAC) and MP3 (ID3v2.4) | 2 |
| #136 | Light mode: paper theme tokens and a dark / light / follow-system switch | 3 |
| #137 | Passkeys, emailed sign-in links, and Sign in with Apple | 3 |
| #138 | Relay billing through a merchant of record | 4 |

### Phase 3 · Jordan · tracking #155

| # | Issue | Sev |
|---|---|---|
| #139 | Hosted accounts: metadata-only libraries on Fly, one SQLite file per account | 4 |
| #140 | Hosted web client at app.legato.fm | 4 |
| #141 | Spotify developer terms review and extended-quota application | 4 |
| #142 | Spotify import: playlists, saved tracks, and taste into a hosted library | 4 |
| #143 | Invites and guest roles, scoped per guest (shared playlists by default) | 3 |
| #144 | Match imported tracks to playable sources, with source badges and "open in Spotify" | 4 |
| #145 | Account data export and deletion | 3 |
| #146 | Small nudges at natural pauses along Jordan's path | 2 |
| #147 | Saved and shareable map views, plus image export | 2 |
| #148 | Make a playlist from a map selection or a path between two artists | 2 |

### Later · tracking #156

| # | Issue | Sev |
|---|---|---|
| #149 | Spike: Tauri 2 mobile (Android and iOS) playback, lock screen, offline | 4 |
| #150 | Spike: Spotify Web Playback SDK inside Legato (after its own terms review) | 3 |
| #151 | More install channels: apt repo, TrueNAS, CasaOS/Umbrel, winget | 2 |
