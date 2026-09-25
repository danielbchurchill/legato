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

The spec is `Legato issue #<N>: <title>.` plus an issue-specific paragraph, then the rules below. The issue-specific paragraph covers the target files, the change, constraints (especially which parallel worker touches nearby files), and acceptance. Orca prefixes branch names with `danielbchurchill/`.

Wait for messages in the background with `orca orchestration check --run <run> --wait --types "worker_done,escalation,question" --timeout-ms 1800000 --json`. That output includes keepalive lines and an `[exited…]` line, so strip both before parsing the JSON. Only release a worker (`worker-release --dispatch <id>`) once it shows succeeded or completed.

## Rules to paste into the spec

```text
HOW TO WORK (applies to every Legato worker):
- Start by reading: `gh issue view <N> --repo danielbchurchill/legato`, then the docs/plans section it links, then CLAUDE.md. Read DESIGN.md before touching any UI. If the issue and the plan doc disagree, the doc wins.
- You are in your own fresh git worktree on your own branch, created from main. Never check out, push to, or edit another worktree or branch. Do not edit anything under docs/plans/.
- Setup: run `source ~/.nvm/nvm.sh && nvm use`. Root `npm install` already ran; run `npm --prefix server install` yourself if you touch server/. Don't install system packages (fpcalc isn't on this Mac; tests that need it already skip). Bun 1.4.2 is installed.
- server/ runs on Bun: tests are `bun:test`, and the DB type is `import type { Database } from "../sqlite.js"` (the adapter in server/src/sqlite.ts). Don't import better-sqlite3 or vitest in server/. Root app tests are vitest, scoped to src/**/*.spec.{ts,tsx}.
- If you add a migration, use the number docs/plans/waves.md assigns to your issue, and run `npm --prefix server run generate:migrations` so server/src/migrations/manifest.generated.ts includes it. The server only applies migrations listed in that manifest.
- Do ONLY the issue's "Done when" list. Anything else is out of scope; mention it in the PR as a follow-up instead of doing it.
- Don't start the app against the Raspberry Pi server, and never trigger scans, tag writes, or any other mutating request against a real library. Tests use `openDb(":memory:")` and fixtures; a standalone server run gets a throwaway `LEGATO_DATA_DIR` under your worktree or /tmp.
- GitHub Actions is blocked by a billing problem, so PR checks will show red no matter what. Local checks are the source of truth.
- Verify before the PR: `npm --prefix server test` if server/ changed; `npm run build`, `npm run lint` and `npx vitest run` if the frontend changed; `cargo test` in src-tauri if Rust changed. Everything must pass. If something was already failing on main, prove it (run it on main) and say so in the PR.
- Commits follow CLAUDE.md's Git section: one logical change each, a subject that tells the story, WHY in the body. End every commit message with: Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- When you're finished, `git fetch origin && git rebase origin/main`, re-run the checks, push, and open a PR with `gh pr create`. The PR body must contain "Closes #<N>" and explain the reasoning, testing and edge cases considered, citing files and line numbers. End it with: 🤖 Generated with [Claude Code](https://claude.com/claude-code). Never merge the PR.
- If the issue and plan doc leave a real decision open, ask the coordinator with your preamble's ask command. Don't guess, and don't open a local question prompt.
- Orca rejects a worker_done or heartbeat that is missing any of its IDs. Every `orca orchestration send` of type worker_done or heartbeat must pass --to, --task-id, --dispatch-id and --dispatch-capability exactly as your preamble gives them (worker_done also needs --outcome). If the send's JSON reply says it was rejected, read the reason, fix every missing field at once, and resend.
- Your worker_done summary must include the PR URL and any "Done when" item you couldn't meet, with the reason.
```

## Why some of these rules exist

- **The migration rule** was added after wave 2. Two parallel workers both chose `0026`, and #102's branch then needed its manifest regenerated after #122 and #123 merged. #174 adds a test that fails when the manifest is stale.
- **The worker_done ID rule** was added after wave 1. Workers kept losing time resending rejected messages one missing field at a time.
- **The "don't touch docs/plans/" rule** keeps the plan docs and this wave plan owned by the coordinator. Each worker's PR then contains only its own issue's work.
