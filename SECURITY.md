# Security

## Reporting a vulnerability

**Please don't open a public issue.** Report it privately, in either of these ways:

- GitHub's **Report a vulnerability** button on this repository's Security tab, or
- email **[hello@legato.fm](mailto:hello@legato.fm)**, with "Security" in the subject.

Include what you found, how to reproduce it, which component and version it affects, and what an attacker could do with it. A proof of concept helps, but isn't required.

## What happens next

- An acknowledgement within **3 working days**.
- An initial assessment, with severity and an expected fix timeline, within **10 working days**.
- Updates until it's fixed. You'll be credited in the release notes if you'd like to be.

Legato is maintained by one person and has no bug bounty. Please give a reasonable window, normally 90 days, before disclosing publicly.

## Scope

In scope:

- **The Legato server:** the sign-in gate, sessions and media tickets, owner creation and setup codes, folder browsing, tag write-back, and token verification.
- **The legato.fm service (`relay/`, at auth.legato.fm):** sign-in, signed tokens and keys, pairing, and the tunnel.
- **The desktop app:** the native sign-in handoff, the Tauri commands, and the bundled server.
- **Install paths:** the Docker image, the install script, and the Homebrew formula.

Out of scope:

- Problems that need an already-compromised machine, or physical access to it.
- Denial of service through sheer volume.
- Findings that only show up in third-party dependencies without a working exploit through Legato. Report those to the dependency upstream.

## Supported versions

Legato is pre-release. Only the latest code on `main`, and the newest release once there is one, get security fixes.
