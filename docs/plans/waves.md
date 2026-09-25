# Worker waves

The order in which the issues in [README.md](README.md#issue-map) get handed to coding-agent workers, and why. The README's issue map and each issue's **Depends on** line decide what *can* start; this file decides what *does* start together.

Each wave's workers run at the same time, each in its own worktree off `main`, following [scripts/orchestration/worker-rules.md](../../scripts/orchestration/worker-rules.md). A wave starts once the previous one has merged. When an issue is ready but not in the current wave, the table says why it was held back. Usually the reason is capacity, or two issues that would edit the same files at the same time.

Update this file when a wave merges or the plan changes. The workers don't edit `docs/plans/`, so it stays the coordinator's.

_Last updated 2026-09-25, `main` at `c2a03e4`._

## Done

| Wave | Issues | PRs |
|---|---|---|
| 1 and earlier | #98, #99, #100, #104, #111, #124, #125, #126, #127 | Merged before this file existed |
| 2 | #102 compiled server, #122 watch-limit fallback, #123 scan stages, #136 light mode | #169, #168, #171, #170 |

Still owed from wave 2, by Daniel rather than a worker:

- #102: the linux-x64 real-hardware smoke test. The steps are in PR #169's body.
- #123: a scan measurement on the real library. The worker measured a synthetic 100k-file tree only.

## Migration numbers

The two parallel workers in wave 2 both picked `0026`. Migration numbers are now assigned here, before a wave starts:

| Number | Issue |
|---|---|
| 0026 | #122 (merged) |
| 0027 | #123 (merged) |
| 0028 | #173 |
| 0029 | #112 |

Give the next free number to any other issue that turns out to need storage, and note it here.

## Wave 3: foundations and the three bugs found in wave 2

Every issue here can start now.

| Issue | Branch | Work | Depends on | Notes |
|---|---|---|---|---|
| #101 | `feature/relay-bun-101` | Move the relay to Bun | #100 ✓ | Starts the identity chain: #114, then #115, #117, #137, #139, #143, #145 |
| #103 | `feature/tauri-sidecar-103` | Tauri runs the compiled server as a sidecar | #102 ✓ | Blocks #129 and #130. Only touches `src-tauri/` |
| #174 | `feature/manifest-drift-test-174` | Fail the tests when the migrations manifest is stale | #102 ✓ | One spec file |
| #173 | `feature/fuzzy-match-index-173` | Index the fuzzy-match tier | #123 ✓ | Uses migration 0028. Re-run the synthetic 100k-file benchmark and report before and after |
| #172 | `fix/library-cold-start-172` | Fetch page 0 before sizing the list | none | Only touches `src/library/` |
| #81 | `fix/icon-button-clicks-81` | Icon buttons need several clicks | none | The issue body is empty, so the worker writes a repro first and posts it before fixing |

## Wave 4: phase 1 foundations

All of these are ready now. They wait for wave 3 to keep the number of workers manageable (Sonnet workers pause on usage limits) and to keep them out of each other's files.

| Issue | Work | Depends on | Held back because |
|---|---|---|---|
| #112 | Local owner account | none | Touches the same server boot and routes as #116, so the two go in together once wave 3 is merged. Blocks #113, #114, #121, #143. Uses migration 0029 |
| #116 | Serve the web client from the home server | #102 ✓ | Same as #112. Also owns embedding the web client in the compiled binary, which #102 deferred |
| #105 | Docker image and compose file | #102 ✓ | Capacity. Blocks #106, #107, #151 |
| #120 | Quality ladder (Opus/AAC tiers) | none | Capacity. Only touches the stream route |
| #86 | Inspector panel content fits its width | none | Touches the same panels as #81 |
| #110 | Update-available notice | #102 ✓ | Capacity. Small |

## Wave 5 and later

These open up as their dependencies merge.

- **Wave 5:**
  - #114 (identity provider; needs #112 and #101)
  - #113, #121 (both need #112)
  - #128 (installable web app; needs #116)
  - #106, #107 (Synology guide and Unraid template; need #105)
  - #108, #109 (install script, Homebrew tap)
- **Wave 6:**
  - #115, #137, #143, #145 (all need #114)
  - #117 (connect screen; needs #116 and #114)
  - #130 (tray and keep-serving; needs #103)
- **Wave 7:**
  - #118, #119 (both need #117)
  - #139 (hosted accounts; needs #114 and #101)
  - #133 (Apple Music import; needs #132)
- **Phase 2 issues with no dependencies**, to fill gaps from wave 5 on: #132, #134, #135 (tag write-back for MP4 and MP3), and #131 (media keys, which needs checking on a real machine).
- **Phase 3 issues with no dependencies:** #147 and #148 come after the phase 1 identity work.
- **Blocked chains:** #140 needs #139, #116 and #117. #142 needs #139 and #141. #144 and #146 come after #142. #149, #150 and #151 are "later" spikes.

## Needs Daniel, not a worker

- **#141:** Daniel submits the Spotify extended-quota application. A worker can draft `docs/plans/spotify-terms.md` first so it's ready. Approval takes time, so start early.
- **#129:** signing needs Daniel's Apple Developer ID and Azure Trusted Signing credentials. It's also blocked on #103.
- **#138:** a worker writes the Paddle vs Lemon Squeezy comparison; Daniel chooses the provider. It's also blocked on #114.

GitHub Actions is blocked by a billing problem, so PR checks show red whatever the code does. Until that's fixed, the local checks in the worker rules are the only real signal.
