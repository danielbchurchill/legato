# Worker rules

Every coding-agent worker gets these rules in its spec, after the issue-specific part. Replace `<N>` with the issue number. The wave plan is in [docs/plans/waves.md](../../docs/plans/waves.md).

## Starting a worker

Each worker is a supervised Orca worker in a new top-level worktree off `main`:

```sh
orca orchestration worker-start \
  --spec "$SPEC" --task-title "#<N> <short title>" \
  --worktree new-top-level --repo id:6cc695d6-6ff0-4017-a144-92d55ace4551 \
  --name <branch> --base-branch main \
  --agent claude --model sonnet --setup run --json
```

The spec is `Legato issue #<N>: <title>.` plus an issue-specific paragraph, then the rules below. Before pasting the rules, replace `<N>`, and replace `<SERVER_PORT>` and `<VITE_PORT>` with the worker's port slot: the wave's first worker gets 8901/5181, the second 8902/5182, and so on. Never hand out 8899, 5173, 5174 or 5175. Those belong to Daniel's own `npx tauri dev`, Airship and the site's dev server. The issue-specific paragraph covers the target files, the change, constraints (especially which parallel worker touches nearby files), and acceptance. Orca prefixes branch names with `danielbchurchill/`.

Wait for messages in the background with `orca orchestration check --run <run> --wait --types "worker_done,escalation,question" --timeout-ms 1800000 --json`. That output includes keepalive lines and an `[exited…]` line, so strip both before parsing the JSON. Only release a worker (`worker-release --dispatch <id>`) once it shows succeeded or completed.

## Rules to paste into the spec

```text
HOW TO WORK (applies to every Legato worker):
- Start by reading: `gh issue view <N> --repo danielbchurchill/legato`, then the docs/plans section it links, then CLAUDE.md. Read DESIGN.md before touching any UI. If the issue and the plan doc disagree, the doc wins.
- You are in your own fresh git worktree on your own branch, created from main. Never check out, push to, or edit another worktree or branch. Do not edit anything under docs/plans/.
- Setup: run `source ~/.nvm/nvm.sh && nvm use`, then `npm --prefix server install`. Root `npm install` already ran. `check:all` runs the server tests, so it needs server deps even when you don't touch server/. Don't install system packages (fpcalc isn't on this Mac; tests that need it already skip). Bun 1.4.2 is installed.
- server/ runs on Bun: tests are `bun:test`, and the DB type is `import type { Database } from "../sqlite.js"` (the adapter in server/src/sqlite.ts). Don't import better-sqlite3 or vitest in server/. Root app tests are vitest, scoped to src/**/*.spec.{ts,tsx}.
- If you add a migration, use the number docs/plans/waves.md assigns to your issue, and run `npm --prefix server run generate:migrations` so server/src/migrations/manifest.generated.ts includes it. The server only applies migrations listed in that manifest.
- Your ports are <SERVER_PORT> (server) and <VITE_PORT> (Vite). Other workers run at the same time, so any standalone run uses them: `LEGATO_PORT=<SERVER_PORT>` for the server, and `npx vite --port <VITE_PORT> --strictPort` for the frontend. Once #179 has merged, also set `VITE_SERVER_PORT=<SERVER_PORT>` so the UI talks to your server. Never bind 8899 or 5173. Don't run `npx tauri dev` or a packaged app without asking the coordinator first: the Tauri shell binds 5173 and 8899 whatever you set.
- Linux is a main platform, not deferred work. Daniel develops on a Linux x64 machine (the AIO), and his server runs on a Linux arm64 Pi. CLAUDE.md's M10 note defers only macOS and Windows *verification*. Anything you add that is platform-specific (build scripts, target tables, binaries, paths) covers linux-x64 and linux-arm64 as well as macOS and Windows. If you can't test Linux on this Mac, say so in the PR; don't leave it out.
- Upgrades happen with nobody at a terminal. Packaged apps, the compiled binary on the Pi, and Docker have no npm and no server/ directory. If your change needs existing data brought forward (a backfill, a new column filled in, a cache rebuilt), the server does it on its own at startup or in a migration. A manual `npm run …` step can be an extra tool, never the upgrade path.
- Do ONLY the issue's "Done when" list. Anything else is out of scope; mention it in the PR as a follow-up instead of doing it.
- Don't start the app against the Raspberry Pi server, and never trigger scans, tag writes, or any other mutating request against a real library. Tests use `openDb(":memory:")` and fixtures; a standalone server run gets a throwaway `LEGATO_DATA_DIR` under your worktree or /tmp.
- GitHub Actions is blocked by a billing problem, so PR checks will show red no matter what. Local checks are the source of truth.
- Verify before the PR with `npm run check:all` from the repo root, whatever you changed. It runs the server tests, vitest, build, lint, the sidecar build (skipped if already built) and `cargo test`, in that order. Everything must pass. If something was already failing on main, prove it (run it on main) and say so in the PR.
- Commits follow CLAUDE.md's Git section: one logical change each, a subject that tells the story, WHY in the body. End every commit message with: Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- When you're finished, `git fetch origin && git rebase origin/main`, re-run the checks, push, and open a PR with `gh pr create`. The PR body must contain "Closes #<N>" only if you checked every "Done when" item yourself, on the platform the issue is about. If an item needs a machine or window you can't reach (the native Tauri window, real Linux hardware, a live deploy), write "Refs #<N>" instead, and add a section for Daniel with the exact steps to check the rest. The PR body must also explain the reasoning, testing and edge cases considered, citing files and line numbers. End it with: 🤖 Generated with [Claude Code](https://claude.com/claude-code). Never merge the PR.
- If the issue and plan doc leave a real decision open, ask the coordinator with your preamble's ask command. Don't guess, and don't open a local question prompt.
- Orca rejects a worker_done or heartbeat that is missing any of its IDs. Every `orca orchestration send` of type worker_done or heartbeat must pass --to, --task-id, --dispatch-id and --dispatch-capability exactly as your preamble gives them (worker_done also needs --outcome). If the send's JSON reply says it was rejected, read the reason, fix every missing field at once, and resend.
- Your worker_done summary must include the PR URL and any "Done when" item you couldn't meet, with the reason.
```

## Why some of these rules exist

- **The migration rule** was added after wave 2. Two parallel workers both chose `0026`, and #102's branch then needed its manifest regenerated after #122 and #123 merged. #174 adds a test that fails when the manifest is stale.
- **The worker_done ID rule** was added after wave 1. Workers kept losing time resending rejected messages one missing field at a time.
- **The port rule** was added after wave 3. The #172 worker couldn't open its fix in a browser, because another worker's server already held 8899 and the frontend hardcoded that port (#179).
- **The Linux rule** was added after wave 3. The #103 worker read CLAUDE.md's M10 note as putting Linux out of scope. Its sidecar build script then failed on every Linux machine, including the AIO it was meant for.
- **The unattended-upgrade rule** was added after wave 3. The #173 worker's first upgrade path was a manual `npm run backfill:fuzzy-index`, which a packaged install or the Pi's compiled binary can't run.
- **The "Refs, not Closes" rule** was added after wave 3. #181 would have auto-closed #81, whose native-window buttons nobody had checked yet.
- **`check:all`** was added after wave 3. With Actions down, workers each chose their own subset of checks. It also runs the sidecar build before `cargo test`, because `tauri-build` fails when the `externalBin` sidecar is missing (#103).
- **The "don't touch docs/plans/" rule** keeps the plan docs and this wave plan owned by the coordinator. Each worker's PR then contains only its own issue's work.
