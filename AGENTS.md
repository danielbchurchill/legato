# Working in this repo

How to work on Legato: the layout, the conventions, and the non-obvious things that have cost real debugging time. It's written for coding agents and human contributors alike. [DESIGN.md](DESIGN.md) owns how the app looks and why. [CONTRIBUTING.md](CONTRIBUTING.md) covers sending a change.

## Layout

| Path | What it is |
|---|---|
| `/` | The desktop app: Tauri 2 + React 19, built with Vite |
| `server/` | The Legato server: Fastify on Bun. It owns the scan, the SQLite database, matching/collapse, enrichment, the hygiene worklist, tag write-back, streaming and sign-in. Its own `package.json` and `node_modules` |
| `relay/` | The legato.fm service on Fly: accounts, signed tokens for home servers, and the remote-access tunnel. Fastify on Bun, its own `package.json` |
| `src-tauri/` | The Rust shell. It spawns the server as a supervised child (`server_process.rs`) and owns native playback (`playback.rs`), the tray (`tray.rs`) and keep-awake (`keep_awake.rs`) |
| `site/` | The legato.fm marketing site: static Vite, deployed to Cloudflare Pages (`site/DEPLOY.md`) |
| `docs/` | User-facing install guides (`docs/install/`) and [development notes](docs/development.md) |
| `packaging/` | The Homebrew formula and the Unraid template |

## Toolchain

- **Node**, pinned in `.nvmrc`. Run `nvm use` first.
- **Bun 1.4.2.** `server/` and `relay/` run on it, and `npx tauri dev`/`build` compile the server sidecar with it. `scripts/build-server-sidecar.mjs` checks for it and prints the install command when it's missing.
- **Rust (stable)** for `src-tauri/`.

## Checks

`npm run check:all` runs every local check, in order: server tests, vitest, build, lint, the sidecar build (skipped if already built), and `cargo test`. Run it before every PR. Relay changes also need `npm --prefix relay test`.

- **Server tests:** `bun:test`, as `*.spec.ts` files next to the source. Use `openDb(":memory:")` for a database. The `Database` type comes from `server/src/sqlite.ts`, the only file that knows the engine is `bun:sqlite`. Don't import `better-sqlite3` or vitest in `server/`.
- **App tests:** vitest, scoped to `src/**/*.spec.{ts,tsx}`.
- **Lint:** oxlint (`.oxlintrc.json`), not eslint.

## Frontend

- React 19, function components and hooks only. TypeScript is strict-ish: `noUnusedLocals`, `noUnusedParameters`, `erasableSyntaxOnly`, `noFallthroughCasesInSwitch`. Vite uses bundler resolution.
- **Styling** is Tailwind v4 with CSS-first config. There's no `tailwind.config.js`; the `@theme` block is in `src/styles/tokens.css`. shadcn/ui is deliberately not used. The shared controls live in `src/ui/`.
- **Fonts** are self-hosted with `@fontsource`: Rubik for the UI and Sometype Mono for data. **Icons** are proicons, vendored as SVG in `src/assets/icons/` behind `src/ui/Icon.tsx`.
- **Read [DESIGN.md](DESIGN.md) before touching any UI.** Older surfaces that still carry inline styles are pre-design-pass code waiting for conversion. Don't copy them.
- **The server address lives in one place:** `src/config/serverHost.ts`, resolved when the page loads. A page the server itself served (tagged `<meta name="legato-server">`) talks to its own origin. Tauri and plain Vite use `VITE_SERVER_HOST` (default `127.0.0.1`) and `VITE_SERVER_PORT` (default `8899`). Import `API_BASE` or `WS_BASE` from there; never hardcode a host or port.
- **Sign-in.** Every `/api` route except `/health` and `/auth/*` needs a session. The fetch wrapper in `src/auth/` adds the bearer token. URLs that can't send headers (`<img>`, `<audio>`, the WebSocket) carry a read-only media ticket as `?t=`.

## Server

- **Running it standalone:** `npm --prefix server run dev` (`bun --watch`). **Always set `LEGATO_DATA_DIR`.** Without it, `config.ts` falls back to `~/.local/share/legato/` and quietly opens a second, empty database. The desktop app sets it to its per-OS app-data dir. Startup logs the database path and file count, so a wrong path is a one-line diagnosis.
- **Ports:** `LEGATO_PORT` (default `8899`). To run a second server and frontend on one machine, set both sides: `LEGATO_PORT=8901` on the server and `VITE_SERVER_PORT=8901` on Vite.
- **A fresh data dir has no owner.** From loopback, `POST /api/v1/auth/owner` creates one without a setup code. From anywhere else, the setup code is required: the server logs it at startup, and `/setup` shows it to devices on the LAN or tailnet.
- **Migrations** are `server/src/migrations/NNNN_*.sql`, applied in order by `openDb()` on every start. The server only applies migrations listed in `manifest.generated.ts`, so after adding one, run `npm --prefix server run generate:migrations`; a spec fails if the manifest is stale. SQLite has no `ALTER … CHECK`, so widening a CHECK constraint means a rebuild-and-swap (see 0014, 0019 and 0029). Before applying pending migrations to an existing database, `openDb()` writes a `VACUUM INTO` copy to `<data dir>/backups/` and keeps the three newest. A one-time data fix must run on its own at startup or inside the migration, never as a manual step: packaged installs and Docker have no npm.
- **The relay has its own migration sequence** in `relay/src/migrations/`, unrelated to the server's.
- **Media binaries:** every ffmpeg/fpcalc spawn goes through `LEGATO_FFMPEG_PATH` / `LEGATO_FPCALC_PATH`, and heavy media work shares one concurrency limit (`server/src/media/queue.ts`, `LEGATO_MEDIA_CONCURRENCY`). Scans take at most limit − 1 slots, so playback always has one.
- **Enrichment sources are keyless:** MusicBrainz, Cover Art Archive, LRCLIB, Deezer (artist photos) and Wikipedia/Wikidata need only a real User-Agent. `ACOUSTID_API_KEY` is the one optional key; without it, the fingerprint tier is off. Local secrets go in `server/.env.local` or `relay/.env.local`, which are gitignored.
- **Tag write-back is FLAC-only for now** (`server/src/tagwrite/`, via `node-taglib-sharp`).
- **mDNS:** the server advertises `_legato._tcp` with its name, id and version (`server/src/discovery/advertise.ts`), and the desktop app browses for it (`src-tauri/src/discovery.rs`). On macOS the server registers through mDNSResponder (`dns-sd -R`), not its own socket: since macOS 15 a process's own multicast needs Local Network permission, and from a terminal without it every multicast send fails with `EHOSTUNREACH`. Loopback multicast still works, which is how the pure-JS responder and the Rust browser can be checked on a Mac. `LEGATO_MDNS=off` stops advertising; `LEGATO_SERVER_NAME` names the server.
- **Cover art** is cached under `<data dir>/covers/<pixel bound>/<hash prefix>/<sha1>.jpg` at two sizes, 256 and 512. A size that's missing is re-derived from the largest copy that survives. Art reaches the canvas through `GET /covers/:hash`, which is content-addressed, and panels through `GET /nodes/:id/cover`.
- **Network contact** is deliberate and listed on legato.fm/privacy. A new outbound request needs a matching line there: the enrichment sources above, the daily update check (`LEGATO_UPDATE_CHECK=off` disables it), and three kinds of legato.fm contact: the signing-key fetch, which only happens once the server is linked to an account or someone has claimed it; the signed report the server sends legato.fm when its owner links or unlinks an account; and the signed claim check (`server/src/auth/claim.ts`), which asks every few seconds whether the setup code was claimed, but only while a `/setup` page is open on a server with no owner. It runs off the page's check-ins, never a timer, so a forgotten server with no owner stays silent.

## Desktop shell

- **How the server is spawned depends on `tauri::is_dev()`.** In `npx tauri dev`, it runs from source (`bun src/index.ts`). In a packaged build, it runs the compiled `legato-server` sidecar that Tauri bundles through `externalBin`, so the target machine needs no Node or Bun. `npm run build:sidecar` makes that binary.
- **`tauri-build` checks that every `externalBin` path exists on every cargo build, dev included.** That's why `beforeDevCommand` builds the sidecar with `--if-missing`. Skip it on a fresh checkout and `cargo check` fails with `resource path … doesn't exist`.
- **The embedded server doesn't hot-reload.** Frontend changes come through Vite HMR; any server change needs the app restarted. A stale server keeps draining the enrichment queue, and a job type it doesn't know about gets marked done. The symptom is a new enrichment feature that silently does nothing. Check `ps aux | grep legato-server` (or `src/index.ts` in dev) before blaming the code.
- **Child processes run in their own process groups** on purpose (`server_process.rs`). Killing the Rust binary alone can leave a stale Vite or server answering on the same port with an old build. Check `lsof -nP -iTCP:5173 -sTCP:LISTEN` and `-iTCP:8899`.
- **Native playback** (decode, gapless scheduling, ReplayGain, output) is in Rust (`rodio`/`cpal`, `playback.rs`), driven through Tauri commands, with `playback://` events going back to React. **Never route final playback through the webview's Web Audio API.** It's unreliable over Bluetooth in WebKitGTK. Browsers and remote clients use the server's stream route, `GET /api/v1/files/:id/stream?quality=…`, instead.
- **Native playback opens files by the path in the server's database.** A client of a remote server needs the library mounted at the same path. Otherwise the transport reports the drive as unreachable.

## Git and PRs

- One logical change per commit. The subject tells the story ("Fix race condition in gapless scheduling", not "fix bug"), and the body says why.
- Branches are descriptive: `feature/…` or `fix/…`.
- A PR explains the reasoning, the testing done and the edge cases considered, with file and line references. Write "Closes #N" only when every item in the issue's "Done when" list was checked on the platform it's about. Otherwise write "Refs #N" and list the remaining steps.
- Linux (x64 and arm64) is a main platform, not deferred work. Anything platform-specific covers Linux as well as macOS and Windows.
