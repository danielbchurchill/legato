# 08 · Jordan's path & Spotify

Gaps: **G10** hosted accounts (severity 4, the account half), **G11** Spotify connector (4). Decisions: D6, D7, D14, D16.

## Jordan's path

| Step | Jordan has | Built by |
|---|---|---|
| 0 · Guest | An invite link to a friend's server, with real audio and no setup | Guests ([03](03-connection-and-streaming.md)) |
| 1 · Hosted account (free) | Spotify import → their taste as a map, playlists, and audio from friends' servers or "open in Spotify" | This doc |
| 2 · Own server | The desktop app serving from their laptop (keep-serving tray) + relay | [07](07-clients.md), [02](02-identity-and-accounts.md) |

Jordan owns no music files, so there is no "owned files" step between 1 and 2. They may stay on step 1 for good, and that's a fine outcome. A hosted music locker is **not** built for launch. It's an experiment to consider after beta (D6).

## Hosted accounts (G10 account half)

- **Architecture (D16):** the same server code in a "hosted" mode, running on Fly.io next to the legato.fm service. Each account gets its own SQLite file (`/data/accounts/<account-id>.sqlite` on a Fly volume) opened with the existing `openDb()`, so all migrations apply unchanged. Hosted mode turns off library roots, the scanner, the watcher, tag write-back and audio streaming at the route level. What's left is the graph, layout, playlists, search and enrichment.
- **Nodes in a hosted library come from imports** (Spotify, and later maybe others), not files. Those rows carry external ids (a Spotify track id plus ISRC, and a MusicBrainz id when enrichment finds one) and no `file_id`.
- One process serves many accounts. Keep an LRU of open database handles, and hold enrichment rate limits globally, not per account, since MusicBrainz's 1 request/second applies to the whole service.
- **Limits:** a cap on imported tracks per account (for example 25k), enforced with a clear message.
- **Backups:** a nightly snapshot of the account files to object storage, deleted with the account (G29).

## Spotify import (G11)

- **OAuth** (authorization code with PKCE), with read-only scopes: `playlist-read-private`, `playlist-read-collaborative`, `user-library-read`, `user-top-read`, `user-follow-read`. No playback scopes (D7).
- **Import:** playlists (with cover and order), saved tracks, followed artists, and top artists/tracks. These become nodes and edges through the same collapse/matching path as scanned files, keyed on ISRC → MusicBrainz → fuzzy (artist, title, duration).
- **Progress per playlist (H1)**, resumable if the connection drops mid-import (Jordan's wi-fi): each playlist is a checkpointed unit. Spotify's 429 responses are respected using `Retry-After`.
- **Terms review first.** Before any code, write a short `docs/plans/spotify-terms.md` covering what the Spotify Developer Terms allow for storing and displaying imported metadata and cover art, the attribution requirements, and the extended-quota application for more than 25 users. The beta exceeds 25 Spotify users only if the quota is granted, so start that application early.
- **Web Playback SDK** (actual Spotify audio inside Legato): not in this phase. It needs Premium and its own terms review. Tracked for later.

## Matching imported tracks to playable sources

For every imported track, work out where it can actually be played, and show that in the UI:
1. **A friend's server Jordan is a guest on**, where the guest scope allows it. This needs a cross-server lookup by ISRC or MusicBrainz id, using an endpoint on the home server that returns only matches, never the whole library.
2. **Jordan's own server**, once they reach step 2.
3. **"Open in Spotify"**: a deep link (`spotify:track:<id>`, falling back to the web URL).

Every track shows a quiet source badge. A playlist says "32 of 40 play here · 8 open in Spotify".

## Nudges (small, at natural pauses)

Only at these moments, only as an inline line of text or a card inside the page, never a modal, and never during playback:
- **The import match report:** "8 of these play here through Sam's server."
- **A guest invite ending:** "Sam's server isn't shared with you anymore. Your map and playlists are still yours."
- **The empty "on your devices" section of a hosted account:** a single line about running Legato on your own computer, linking to the download.

Each nudge can be dismissed permanently. Track dismissals and follow-throughs (counts only, no content) to see whether the path works.
