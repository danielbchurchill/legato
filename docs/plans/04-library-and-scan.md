# 04 · Library & scan

Gaps: **G2** server-side folder picker (severity 4), **G3** auto-detect (3), **G4** scan stages / ETA / pause (3), **G5** Apple Music import (3), **G6** tag write beyond FLAC (2), **G13** playback test (2), **G21** M3U import (3). Plus two issues found during planning: Synology junk folders and the file-watch limit. Decision: D17.

## Current state

- `src/LibrarySetup.tsx` uses Tauri's native `open({ directory: true })`, which only browses the machine running the UI. Useless for a headless server.
- `server/src/routes/library-roots.ts` manages the roots. `server/src/routes/scan.ts` plus the `scan:progress` WS event (`filesScanned` / `filesTotal`) are the only progress data. There's no cancel.
- `server/src/scan/walk.ts:16` and `server/src/scan/watcher.ts:25` skip `lost+found`, `.Trash-*`, and `System Volume Information`, but **not** Synology's `@eaDir` or `#recycle`.
- `server/src/tagwrite/` is FLAC-only by design (via `node-taglib-sharp`, which also supports MP4 and ID3v2).
- `PlaybackSpike` is a debug-gated smoke test, not a user-facing step.

## Synology junk folders (do first, it's tiny)

Add `@eaDir`, `#recycle`, `#snapshot`, `.@__thumb` (QNAP), and `.DS_Store`/`._*` AppleDouble files to both ignore lists. Put them in one shared constant so the walker and watcher can't drift apart. Add a test with a fixture tree.

## File-watch limit fallback

The watcher uses inotify on Linux, one watch per directory. Synology's low default `fs.inotify.max_user_watches` runs out on a big library, and once it does, new files stop showing up with no error.

- Detect `ENOSPC` / `EMFILE` from chokidar, and any watch count close to `/proc/sys/fs/inotify/max_user_watches`.
- Fall back to a periodic incremental rescan (default every 30 minutes, configurable), plus a manual "check for new music" action.
- Show it (H1, H9): "Watching for changes isn't available on this system, so Legato checks every 30 minutes." Include a docs link explaining how to raise the limit on Synology (a Task Scheduler boot task).

## Server-side folder picker (G2)

- `GET /api/v1/fs/browse?path=` lists directories only, with a count of audio files at the top level and in the first level of subfolders ("412 audio files"), so people pick the right folder without guessing.
- It's restricted to the owner. Don't block `/proc` and `/sys` by rule; instead only start browsing from mount points and the home directory (plus `/music` inside Docker).
- It's a UI component on every client, replacing Tauri's native dialog **when the server isn't on this machine**. The desktop app with its built-in server can keep the native dialog (H4: platform convention).
- In Docker it explains itself: "You're seeing the folders mounted into Legato's container. To add another, edit the compose file." Link to docs.

## Library auto-detect (G3)

On first run, suggest candidates with counts before asking for a path (H6):
- macOS: `~/Music/Music/Media` (Apple Music), `~/Music/iTunes/iTunes Media`, `~/Music`
- Windows: `%USERPROFILE%\Music`, the iTunes Media folder
- Linux: `~/Music`, `/mnt/*`, `/media/*/*` with audio in them
- Docker: `/music`

Each candidate shows "about N tracks" from a quick, capped count. Picking one feeds the normal root-add flow.

## Scan stages, ETA, pause / resume / cancel (G4)

- **Stages:** `discover` (walk) → `read tags` → `match` → `collapse` → `layout` → `enrich queued`. Each reports `done / total` where the total is known, a rate (files per second over a sliding window), and an ETA once the rate is stable (at least 20 seconds of samples). Otherwise it shows "estimating…" rather than a guess (H1).
- **Checkpoint:** a `scan_runs` row holds the current stage and its cursor (last path or file id handled). **Pause** stops after the current file and survives server restarts. **Resume** continues from the cursor. **Cancel** stops, keeps everything indexed so far, and marks the run canceled (D17).
- UI: the scan panel shows the stage list with a single progress bar for the current stage, rate, ETA, and pause/cancel controls. Errors are listed per file ("3 files couldn't be read") with the path and the reason, and don't stop the scan (H9).
- It has to feel normal at 180k files: batch writes, and throttle progress events to about 4 per second.

## Apple Music import (G5)

- Read Apple Music's library through its exported `Library.xml` (File → Library → Export Library), or, if it exists, the `iTunes Library.xml` sharing file. No private APIs.
- Import playlists (matched to scanned files by location first, then by metadata), play counts, ratings, and date added. Put play counts in `plays` as one imported total per track, not fake per-play events.
- **Cloud-only tracks** (no `Location`, or `Track Type` = Remote) are listed in the import report as "in your Apple Music library but not downloaded to this Mac", with a link explaining how to download them. Never fail silently (H9).

## M3U / M3U8 import (G21)

- Upload or pick a `.m3u`/`.m3u8`. The paths inside often point at another machine (`D:\Music\…`, `/Volumes/Music/…`).
- **Path remap:** detect the longest common prefix of the unmatched paths, and offer "replace `D:\Music\` with `/music/`" as a one-click suggestion, with a preview of how many tracks then match.
- **Match report** per playlist: matched / matched by metadata fallback (artist + title + duration ±2s) / missing, listing the missing tracks. Import creates the playlist with whatever matched, and the report stays viewable afterwards.

## Playback test (G13)

It closes out J1: "Play something." Plays a short gapless album pair (the last 5 seconds of a track into the first 5 seconds of the next) and shows the signal path as it happens: `source FLAC 24/96 → decode → ReplayGain −6.2 dB → output: <device name> 48 kHz`, or `→ transcode Opus 160 → browser` for web. It's a real user step that can be skipped and run again from settings. Keep the debug-gated spike.

## Tag write-back beyond FLAC (G6)

`node-taglib-sharp` already supports MP4 (ALAC/AAC) and ID3v2.4 (MP3). Extend `server/src/tagwrite/` format by format:
- **MP4:** `©nam`/`©ART`/`aART`/`©alb`, MusicBrainz freeform atoms (`----:com.apple.iTunes:MusicBrainz Album Id`, …).
- **MP3:** ID3v2.4 frames, with `TXXX` for the MusicBrainz ids.

Each format gets the same read-after-write verification and write guard as FLAC, plus tests with real fixture files. Keep write-back opt-in.
