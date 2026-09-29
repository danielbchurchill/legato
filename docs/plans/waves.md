# Worker waves

The order in which the issues in [README.md](README.md#issue-map) get handed to coding-agent workers, and why. The README's issue map and each issue's **Depends on** line decide what *can* start; this file decides what *does* start together.

Each wave's workers run at the same time, each in its own worktree off `main`, following [scripts/orchestration/worker-rules.md](../../scripts/orchestration/worker-rules.md). A wave starts once the previous one has merged. When an issue is ready but not in the current wave, the table says why it was held back. Usually the reason is capacity, or two issues that would edit the same files at the same time.

Update this file when a wave merges or the plan changes. The workers don't edit `docs/plans/`, so it stays the coordinator's.

_Last updated 2026-09-29, `main` at `23bfde4`._

## Done

| Wave | Issues | PRs |
|---|---|---|
| 1 and earlier | #98, #99, #100, #104, #111, #124, #125, #126, #127 | Merged before this file existed |
| 2 | #102 compiled server, #122 watch-limit fallback, #123 scan stages, #136 light mode | #169, #168, #171, #170 |
| 3 | #101 relay on Bun, #103 Tauri sidecar, #174 manifest drift test, #173 fuzzy-match index, #172 library cold start, #81 icon button clicks | #177, #180, #176, #182, #178, #181 |

Still owed, by Daniel rather than a worker:

- #102: the linux-x64 real-hardware smoke test of the *compiled* binary. The steps are in PR #169's body. The AIO has run `npx tauri dev`, which runs the server from source, so that doesn't count.
- #123: a scan measurement on the real library. The worker measured a synthetic 100k-file tree only.
- #101: the relay's OAuth secrets (`relay/DEPLOY.md` step 3). The relay is live on Fly and `/health` passes, but `/auth/*` and `/pair/*` return 503 until the secrets are set.
- #103: optionally, a packaged Linux build (`npx tauri build`) run with Node and Bun off PATH. The Mac's packaged run and the AIO's dev run both pass.

Wave 3 found six follow-ups, filed as #184–#189 and scheduled below. It also found #179, now in wave 4. A review of the session's failures added four safeguards, #191–#194, and a drive-recovery item on #108.

## Migration numbers

The two parallel workers in wave 2 both picked `0026`. Migration numbers are now assigned here, before a wave starts:

| Number | Issue |
|---|---|
| 0026 | #122 (merged) |
| 0027 | #123 (merged) |
| 0028 | #173 (merged) |
| 0029 | #112 |
| 0030 | #189, if its fix needs an index or column |

Give the next free number to any other issue that turns out to need storage, and note it here.

## Wave 4: phase 1 foundations

Wave 3 is merged, so this is the current wave. It starts in two steps, so no two workers rewrite the same files:

1. **Start now:** #179, #191, #192, #105, #86, #187.
2. **Once #179 has merged:** #112, #116 and #193.

That's six workers in step 1 and three in step 2. #110 and #120 moved to wave 5 to keep it there. #110 now depends on #193, and nothing in wave 4 needs #120.

| Issue | Work | Depends on | Notes |
|---|---|---|---|
| #179 | Make the server port configurable in the frontend | none | Found by the #172 worker in wave 3. Rewrites the API/WS base in about 25 files across `src/`. #116 then rebases onto it, so #116 changes only `serverHost.ts` instead of sweeping the same 25 files again. Any new frontend code in #86 and #110 imports the shared base from `serverHost.ts` |
| #191 | Back up the database before migrating | none | Step 1. Only touches `server/src/db.ts` and a CLAUDE.md line. Goes in before #112 adds 0029, so every migration from here on lands with a backup behind it |
| #192 | Don't mark the library missing when its drive isn't reachable | none | Step 1. Touches `server/src/scan/` and `server/src/routes/health.ts`. #193 also edits `health.ts`, a small file, so whichever merges second rebases |
| #193 | Server version in `/health`, client warns when the server is too old | #179 | Step 2. Its client half edits `useServerReady.ts`, which #179 rewrites. Blocks #110 |
| #112 | Local owner account | none | Step 2. Touches the same server boot and routes as #116, so the two go in together. Blocks #113, #114, #121, #143. Uses migration 0029 |
| #116 | Serve the web client from the home server | #102 ✓ | Step 2. Waits for #179, for the reason in #179's row. Also owns embedding the web client in the compiled binary, which #102 deferred |
| #105 | Docker image and compose file | #102 ✓ | Blocks #106, #107, #151 |
| #86 | Inspector panel content fits its width | none | Held from wave 3 because it touches the same panels as #81. #179 also edits those panels, but only their API base line, so a rebase is trivial |
| #187 | Sidecar build checks for Bun first | #103 ✓ | Found on the AIO in wave 3. Only touches `scripts/build-server-sidecar.mjs` and a CLAUDE.md line |

## Wave 5 and later

These open up as their dependencies merge.

- **Wave 5:**
  - #114 (identity provider; needs #112 and #101 ✓)
  - #113, #121 (both need #112)
  - #128 (installable web app; needs #116)
  - #106, #107 (Synology guide and Unraid template; need #105)
  - #108, #109 (install script, Homebrew tap)
  - #184 then #186, **one worker, one after the other**. Both edit `src/playback/usePlayback.ts`. #184 surfaces native playback errors; #186 puts `queue_set_repeat` under `serialized()`. Held until wave 5 because #179 rewrites `usePlayback.ts`'s API base in wave 4
  - #189 (collapse/layout/enrich_queued scaling; needs #173 ✓). Server scan code only. Uses migration 0030 if it needs one. Held back for capacity
  - #188 (`build.yml` sidecar build). Held back because it can't be verified on GitHub until the Actions billing problem is fixed. Its local check still means something, so it goes in once there's capacity
  - #130 (tray and keep-serving; #103 ✓ has merged, so it's ready)
  - #110 (update-available notice; needs #193, since it reads the version fields #193 adds)
  - #120 (quality ladder; moved from wave 4 for capacity). Only touches the stream route. #185 builds on it, so it has to land in wave 5 for #185 to start in wave 6
  - #194 (one-command deploy to a standalone host; needs #102 ✓). Only touches `scripts/` and CLAUDE.md's Pi note. Its real deploy to the Pi needs Daniel's go-ahead
  - #108 already sits in this wave. Its "Done when" now includes a unit that recovers when the library drive comes back, fixing the Pi's `ConditionPathIsMountPoint` gate
- **Wave 6:**
  - #115, #137, #143, #145 (all need #114)
  - #117 (connect screen; needs #116 and #114)
  - #185 (native client falls back to the server stream; needs #184 and #120). **Before it starts, the coordinator adds a section to [03-connection-and-streaming.md](03-connection-and-streaming.md)** settling how `playback.rs` reads an HTTP stream, what gapless and seek mean over it, and how it relates to #120's ladder. Write that section during wave 5
- **Wave 7:**
  - #118, #119 (both need #117)
  - #139 (hosted accounts; needs #114 and #101 ✓)
  - #133 (Apple Music import; needs #132)
- **Phase 2 issues with no dependencies**, to fill gaps from wave 5 on: #132, #134, #135 (tag write-back for MP4 and MP3), and #131 (media keys, which needs checking on a real machine).
- **Phase 3 issues with no dependencies:** #147 and #148 come after the phase 1 identity work.
- **Blocked chains:** #140 needs #139, #116 and #117. #142 needs #139 and #141. #144 and #146 come after #142. #149, #150 and #151 are "later" spikes.

## Needs Daniel, not a worker

- **#141:** Daniel submits the Spotify extended-quota application. A worker can draft `docs/plans/spotify-terms.md` first so it's ready. Approval takes time, so start early.
- **#129:** signing needs Daniel's Apple Developer ID and Azure Trusted Signing credentials. Its #103 blocker has merged. It also needs #188, since signing happens in the same `build.yml` run.
- **#138:** a worker writes the Paddle vs Lemon Squeezy comparison; Daniel chooses the provider. It's also blocked on #114.

GitHub Actions is blocked by a billing problem, so PR checks show red whatever the code does. Until that's fixed, the local checks in the worker rules are the only real signal.
