# 01 · Server distribution

Gaps: **G1** headless server packaging (severity 3), **G9** signed builds (severity 4, where this doc covers only its server half). Decisions: D2–D5 in [README](README.md).

## Why this comes first

The server only runs today because every machine it has run on has Node and npm installed:

- `server/package.json` runs `tsx src/index.ts` for both `dev` and `start`.
- `src-tauri/src/server_process.rs:66` starts the embedded server with `Command::new("npm")` → `npm run start` → sh → tsx → node.
- The Pi's `legato-server` systemd user unit is hand-written and points at a checkout.

So Rowan can't install without Node, and Priya's signed Mac app would fail on first launch. Both problems have one fix: a self-contained server binary.

## Current state worth knowing

- **SQLite is almost entirely behind types.** Of 87 `better-sqlite3` imports in `server/src`, 85 are `import type Database`; the only value imports are in `server/src/db.ts` and `relay/src/db.ts`. The Bun migration really means one adapter plus fixing types.
- **Direct uses of the API** (`.pragma()`, `.transaction()`, `.iterate()`, `.pluck()`, `.raw()`) need an audit. `bun:sqlite` has no `.pragma()` (use `db.exec("PRAGMA …")` / `db.query`), and its named parameters differ unless the database is opened with `{ strict: true }`. Open it with `strict: true` so `@name`/`$name` keep working the way better-sqlite3 binds them.
- **ffmpeg and fpcalc stay separate executables.** `server/src/mediaBinaries.ts` already resolves `LEGATO_FFMPEG_PATH` / `LEGATO_FPCALC_PATH`, and `scripts/fetch-media-binaries.mjs` fetches builds for bundling. **Bug:** `server/src/index.ts:179` still calls plain `spawn("ffmpeg", …)` instead of `FFMPEG_PATH`, so a packaged build with no system ffmpeg fails on that route.
- **Tests:** 57 vitest spec files in `server/`, plus the relay's. vitest runs on Node, where `bun:sqlite` doesn't exist.

## Design

### Bun migration (server first, relay second)

1. Add a `server/src/sqlite.ts` adapter that exports the `Database` type and an `openSqlite(path)` function backed by `bun:sqlite`. Point all 85 type imports at the adapter, so the choice of engine lives in one file.
2. Replace `.pragma()` calls. Check `.transaction()` (both libraries have it, with the same shape), `.iterate()`, and statement options.
3. **Test runner:** move to `bun test` (Jest-compatible API). `vi.fn`/`vi.mock` become `mock`/`mock.module` from `bun:test`. Do it file by file, and keep the suite green at every commit. The done-when bar is the full suite (currently ~325 tests, more since) passing under `bun test`.
4. Check the risky dependencies under Bun: `@fastify/websocket` (uses `ws`, supported), `chokidar` v5, `music-metadata`, `node-taglib-sharp` (sync `fs`), `child_process.spawn`. Write down every workaround in the PR.
5. **Relay:** the same adapter pattern, as a separate issue. It deploys on Fly with its own Dockerfile, and moving it lets hosted accounts (D16) share server modules.

### Compile

- `bun build --compile --target=bun-<os>-<arch>[-baseline]` for linux-x64-baseline, linux-arm64, darwin-arm64, darwin-x64-baseline, windows-x64-baseline.
- Migrations: `server/src/db.ts` reads `server/src/migrations/*.sql` from disk. A compiled binary has no source tree, so embed the files with `import … with { type: "text" }` or a generated manifest. **This is the most likely thing to break silently. Test a compiled binary against an empty data dir.**
- Release workflow: build all five targets on tag, attach them together with ffmpeg + fpcalc as per-target archives (`legato-server-<version>-<target>.tar.gz` / `.zip`) and `SHA256SUMS`.
- `legato-server --version` prints the version plus the git SHA the build came from.

### Tauri sidecar

Replace the npm process tree in `server_process.rs` with Tauri's `externalBin` sidecar for the compiled binary, keeping the `LEGATO_DATA_DIR` / `LEGATO_PORT` / media-binary env handoff. The process-group kill logic exists because of npm → sh → tsx → node. With one process it simplifies, but keep the group kill for ffmpeg children. Dev mode (`npx tauri dev`) can keep running from source via `bun --watch`.

### Docker + Synology

- Multi-arch image (`linux/amd64`, `linux/arm64`) on GHCR, `debian:bookworm-slim` plus Debian's `ffmpeg` and `libchromaprint-tools` packages, running as a non-root user.
- `docs/install/docker-compose.yml`: library mounted **read-only** at `/music` (H5; tag write-back is opt-in and needs a read-write remount, and the docs say so), a named volume for data, `PUID`/`PGID`, and port 8899.
- `docs/install/synology.md`: Container Manager → Project → paste the compose file. Find `PUID`/`PGID` with `id <user>` over SSH, or in the Container Manager user dropdown. Shared-folder permissions (the ACL needs read for that user). Notes that DS\*j and ARM models can't run Container Manager.

### Install script + Homebrew

- `site/public/install.sh`, served at `legato.fm/install`. POSIX sh, under ~150 lines, readable before piping, and it verifies `SHA256SUMS`. It installs to `~/.local/share/legato/bin` and writes a systemd **user** unit shaped like the Pi's (including a documented `ConditionPathIsMountPoint` option for mounted drives). It prints the setup URL and claim code at the end (see [02](02-identity-and-accounts.md)).
- `danielbchurchill/homebrew-legato` tap: the formula downloads the release archive, depends on `ffmpeg` and `chromaprint` from Homebrew, and `service do` gives `brew services start legato`.
- Unraid: a Community Applications XML template wrapping the Docker image. Small, once the image exists.

### Update notices (notify only)

- The server checks the GitHub releases API at most daily. It can be turned off, and nothing about the library is sent.
- Each build knows its install channel through `LEGATO_INSTALL_CHANNEL=docker|script|brew|desktop`, baked in or set per channel. The UI shows "Legato 0.4.0 is available" with the channel's exact command (`docker compose pull && docker compose up -d`, `legato update`, `brew upgrade legato`). The desktop app uses Tauri's updater instead (that's part of G9's signing work).

### Low-power hosts

Synology "+" models ship with a J4125 or similar CPU and 2–4 GB of RAM. Add a concurrency limit shared by ffmpeg transcodes, fingerprinting and cover derivation (default `max(1, cores - 1)`, configurable), with playback transcodes ahead of background work in the queue. A fresh 180k-file scan must never starve the track someone is listening to.

## Risks

- A Bun incompatibility deep in a dependency. Mitigation: the dependency check in step 4 comes before any compile work.
- Embedding migrations. Mitigation: a CI job boots the compiled binary against an empty data dir and checks the migration count.
- macOS Gatekeeper quarantining an unsigned sidecar. The sidecar is signed as part of the app bundle in G9's signing issue.
