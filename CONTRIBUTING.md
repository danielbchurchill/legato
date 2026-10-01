# Contributing to Legato

Thanks for wanting to help. Legato is pre-release and built mostly by one person, so the easiest way to get a change in is to talk first.

## Before you start

- **Open an issue before a large change.** For anything beyond a small fix, describe what you want to do and why. A short conversation saves both of us from a PR that goes the wrong way.
- **Read [AGENTS.md](AGENTS.md).** It covers the layout, the conventions, and the parts of the codebase that have caused real bugs before. If you touch the UI, read [DESIGN.md](DESIGN.md) too.

## Making the change

1. Set up the toolchain as described in the README's [Building from source](README.md#building-from-source).
2. Keep each commit to one logical change. The subject says what changed ("Fix race condition in gapless scheduling", not "fix bug"), and the body says why.
3. Add or update tests next to the code: `bun:test` in `server/` and `relay/`, vitest in `src/`.
4. Run `npm run check:all` and make sure it passes. Relay changes also need `npm --prefix relay test`.

## Opening the pull request

- Explain the reasoning, how you tested it, and the edge cases you considered.
- Write "Closes #N" only if the change fully resolves the issue on every platform it affects. Otherwise write "Refs #N" and say what's left.
- Anything platform-specific should work on Linux as well as macOS and Windows. If you couldn't test a platform, say so.

## The Contributor License Agreement

Before a pull request can be merged, its author signs the [Contributor License Agreement](CLA.md). A bot asks you to do this on your first PR. You keep the copyright in your work. The CLA gives the project permission to distribute it under the AGPL and under other licences. That's what lets Legato offer the hosted relay and change licensing terms later without contacting every past contributor.

## Names and logos

Contributions to the code are welcome under the licence. The Legato name and logo aren't. If you publish a fork, follow [TRADEMARKS.md](TRADEMARKS.md).

## Security problems

Don't open a public issue for a vulnerability. Follow [SECURITY.md](SECURITY.md).
