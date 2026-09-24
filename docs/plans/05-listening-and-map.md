# 05 · Listening & map

Gaps: **G7** non-map library view (severity 3), **G20** repeat / scoped shuffle (3), **G22** map presets / undo / defaults (3), **G23** saved views + image export (2), **G24** map-to-playlist (2). Decisions: D11, D12, D19.

## Current state

- `src/shell/TransportDock.tsx` has a shuffle toggle and no repeat.
- `src/panels/Playlists.tsx` has "shuffle play". `server/src/routes/queue.ts` holds the queue.
- `src/panels/MusicMapSettings.tsx` has lock, producers, size, images, colours, distance, thickness, and the center/repel/link forces. No presets, no undo, no reset.
- No list or grid view of the library exists. DESIGN.md says "the graph is the application".

## Shuffle and repeat (G20)

- **Shuffle belongs to a queue, not the player.** When a queue is created (play album, play playlist, play artist, play selection) it records `order: 'in-order' | 'shuffled'` and keeps its shuffled permutation, so turning shuffle off returns to the original order at the current track. "Play" on an album always starts in order. The dock's shuffle control toggles the **current queue** only, and nothing global is persisted.
- **Repeat** is `off → all → one`, a player setting that persists (it's a listening preference, unlike shuffle). The dock shows the current mode, and `aria-label` states it in words.
- Gapless scheduling in `src-tauri/src/playback.rs` has to handle repeat-one (re-enqueue the same source) and repeat-all (wrap around at the end of the queue) without a gap. Add Rust tests for both.

## Library view (G7)

- A **map / library** switch in the shell; the choice persists. The library view has two layouts:
  - **Albums:** a cover grid (cover art from `GET /nodes/:id/cover`), sortable by artist, title, year, date added, or recently played.
  - **Tracks:** a virtualized table (title, artist, album, duration, format, date added). Library data uses Sometype Mono, per DESIGN.md.
- Search and filters are shared with the map, so what's selected carries over when switching.
- It uses DESIGN.md's glass and type rules. Amend DESIGN.md with a short "Library view" section in the same PR, recording decision D11.
- It must stay fast at 30k albums: virtualize, and load covers lazily at the 256px size.

## Map presets, labels, undo, defaults (G22)

- **Presets:** *clusters* (strong link force, low repel), *balanced* (today's defaults), *sprawl* (weak link, high repel). Each one is a named bundle of the existing settings, not new physics.
- **Plain-language labels:**
  - "link force" becomes "how tightly related music pulls together"
  - "repel" becomes "space between everything"
  - "center" becomes "pull toward the middle"

  The technical name moves to secondary text.
- **Undo:** a session history of settings changes, with ⌘Z/Ctrl+Z and an undo button inside the panel. **Restore defaults** returns to *balanced*.
- **Recovery (H9):** if a setting leaves the map empty or off-screen (Jordan setting repel to the maximum), show "The map spread out of view", with a "re-center" button and a "restore defaults" button.

## Saved views and image export (G23)

A saved view is the camera position and zoom, the filters, the settings preset or overrides, and the selection. Views are stored per user on the server. **Share** produces a link that opens the same view, for the user's own devices or for guests who are allowed to see what's in it. **Export image** renders the current canvas at 2× to PNG, with the wordmark in a corner.

## Map-to-playlist (G24)

Lasso or shift-click selection on the map, or "tracks along the path between these two artists" (the shortest path over the edges). "Make playlist from selection" creates a playlist with the tracks in map order or shuffled, then opens it for editing.
