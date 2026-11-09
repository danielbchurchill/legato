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

## Working on the update notice

A dev build never checks for updates on its own (`src-tauri/src/updater.rs`). To see the notice, serve a `latest.json` that offers a newer version and point the app at it. Its update has to be signed, so make a throwaway key and sign any file with it:

```sh
mkdir -p scratch.local/updater-stub && cd scratch.local/updater-stub
npx tauri signer generate --ci -p stub -w stub.key
head -c 1000000 /dev/urandom > update.bin
npx tauri signer sign -f stub.key -p stub update.bin
cat > latest.json <<EOF
{ "version": "0.3.0", "platforms": { "darwin-aarch64": {
  "url": "http://127.0.0.1:8971/update.bin", "signature": "$(cat update.bin.sig)" } } }
EOF
python3 -m http.server 8971 --bind 127.0.0.1
```

Use your own platform's key: `darwin-aarch64`, `darwin-x86_64`, `linux-x86_64`, `linux-aarch64` or `windows-x86_64`. Then, from the repo root:

```sh
LEGATO_UPDATER_ENDPOINT=http://127.0.0.1:8971/latest.json \
LEGATO_UPDATER_PUBKEY="$(cat scratch.local/updater-stub/stub.key.pub)" \
npm run dev:instance -- --server-port 8906 --vite-port 5186 --data-dir "$PWD/scratch.local/instance"
```

The notice shows under the search bar once the download has verified. In a dev build, "restart to update" doesn't install anything.

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

## When a release run fails

A version tag starts `.github/workflows/release.yml`, and its `release` job downloads ffmpeg and fpcalc for every server target from outside hosts. Those hosts sometimes refuse a GitHub runner's address: an HTTP 429, a 5xx, or an HTTP 200 carrying a web page in place of the file. johnvansickle.com, the Linux ffmpeg source, has sent the page (#443). `scripts/fetch-release-media-binaries.mjs` asks again four times over about two minutes, then fails, saying which host sent what.

When it fails anyway, open the run in GitHub Actions and choose **Re-run failed jobs**. That's safe: nothing is published before the job's publish step, so a failed download leaves no release, image or tap bump behind. For v0.2.0, a rerun two minutes later passed. If one host keeps refusing across reruns, that source needs replacing in the script, as evermeet.cx was after v0.1.0.

The desktop app (#129) fetches the same binaries in `desktop`'s `media` job, and builds alongside the server release rather than before it. So when a desktop job fails, the release is already up with the server archives, but no desktop bundles and no `latest.json`, which installed apps read as a failed check and try again the next day. **Re-run failed jobs** builds the missing ones and `desktop-publish` attaches them, replacing anything a failed upload left behind. A tag with a desktop signing secret missing fails in `preflight`, before anything is published.

## Platforms

Development happens on Linux and macOS. `.github/workflows/build.yml` builds the desktop app for every platform a release ships (macOS arm64 and x64, Windows x64, Linux x64 and arm64) through `desktop.yml`, the workflow each release tag runs. Its Mac build is signed only on main and on release tags, the only refs the desktop-signing environment's keys are for; a pull request's is unsigned and says so. Windows builds are unsigned until #483, so SmartScreen warns. Linux (x64 and arm64) is a main platform for both the app and the server. Installing a release, warnings included, is [docs/install/desktop.md](install/desktop.md).
