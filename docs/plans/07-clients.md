# 07 · Clients

Gaps: **G9** signed builds + native media integration (severity 4), **G10** hosted web client (4, the client half; the account half is in [08](08-jordan-and-spotify.md)), **G14** Android (4), **G15** iOS + offline (4), **G16** installable web app (2). Decision: D9.

## Installable web app (G16), phase 1

Depends on the home server serving the web client with a runtime host ([03](03-connection-and-streaming.md)).

- `manifest.webmanifest` (name, icons from the brand assets, `display: standalone`, theme colour per theme), and a service worker that caches the app shell only. **Never cache API responses or audio**: stale library data served offline is worse than an honest "can't reach your server".
- **Media Session API:** title, artist, album, artwork, and play/pause/next/previous/seek, so the phone's lock screen and headphone buttons work. This is Rowan's Android client until mobile apps exist.
- Background audio in mobile browsers only works with a real `<audio>` element and a Media Session. Test on Android Chrome with the screen locked for 30 minutes, and write the iOS Safari result in the PR (iOS may suspend it, which is exactly why native iOS is needed later).
- An install prompt at a natural moment (after the first successful playback), never on page load.

## Signed desktop builds (G9), phase 2

Depends on the Tauri sidecar ([01](01-server-distribution.md)).

- **macOS:** a Developer ID Application certificate, hardened runtime, notarization via `notarytool` in CI, and stapling. Build **arm64 and x64 separately**, or universal if both sidecars fit (the Intel tester in D3 must get a native build). The sidecar, ffmpeg and fpcalc are signed inside the bundle.
- **Windows:** an Authenticode certificate (an Azure Trusted Signing account is the cheapest route to avoiding SmartScreen warnings), signing the installer and every bundled executable.
- **Tauri updater** with signed update manifests, for the desktop app only (server channels are notify-only, D5).
- Extend `.github/workflows/build.yml` from the current "does it build" matrix into release builds on tag, with secrets in GitHub environments. Linux keeps shipping unsigned AppImage and `.deb`.

## Keep serving when the window closes (Priya's Mac-as-server), phase 2

- A tray / menu-bar icon: "Legato is serving your library", with open, pause serving, and quit.
- Closing the window keeps the server and tunnel running. A setting to launch at login turns on the `tauri-plugin-autostart` login item.
- **"Keep this Mac awake while serving"**: an opt-in power assertion (`IOPMAssertionCreateWithName` on macOS, `SetThreadExecutionState` on Windows) that's released when nothing has been streamed for a while. Its explanation says what it costs in battery.

## Native media integration (G9), phase 2

Media keys and the OS "now playing" surfaces for the native Rust player: MPNowPlayingInfoCenter + MPRemoteCommandCenter on macOS, SMTC on Windows, MPRIS on Linux. The `souvlaki` crate covers all three. It's wired to the existing `playback.rs` commands and the `playback://track-changed` events.

## Hosted web client (G10 client half), phase 3

Depends on hosted accounts ([08](08-jordan-and-spotify.md)) and the runtime host.

- `app.legato.fm` serves the same frontend build. After sign-in, the connect screen lists the account's hosted library plus any servers it owns or is a guest on.
- Deploy it as a Cloudflare Pages project next to `site/` (the frontend is static), with API calls going to the legato.fm service on Fly.
- Content-Security-Policy and a same-site cookie plan are written down in the PR.

## Mobile apps (G14, G15), later

A spike first: build Tauri 2 for Android and iOS from this repo, and answer three questions before committing to anything:
1. Does `rodio`/`cpal` playback keep going with the screen locked (iOS needs the `audio` background mode and an active `AVAudioSession`)?
2. Can lock-screen controls be wired from Rust or a small Swift/Kotlin plugin?
3. **Offline downloads (iOS, Priya):** where do downloaded files live, and how big does the app get?

The spike's written findings decide whether mobile stays on Tauri or gets a native shell around the shared server protocol.
