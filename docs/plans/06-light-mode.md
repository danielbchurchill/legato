# 06 · Light mode

Gap: **G8** (severity 3). Decision: D10. Light mode is a full second theme and ships at launch.

## Design goal

**Sheet music in colour and contrast.** Warm paper that is *not* yellow: a subtly tinted off-white, the colour of good engraving paper under daylight, not parchment. Ink is pen-ink black, a little softer than pure `#000`. Staff-line grays for dividers. The dark theme stays exactly as it is.

## Step 1: palette in Figma (design issue, Daniel reviews)

In the Figma file [Legato — Personas & UX Journeys](https://www.figma.com/design/xw26F52SViCZptggBFBBBP), or a new design file, add a **"paper" mode** to the existing *Legato tokens* variable collection (currently `dark (only)`, which becomes `dark`) and fill in every variable:

- `canvas`, `inset`, `surface`, `surface-flat`: paper tones. As a starting point, off-white with the smallest warm tint that avoids reading as yellow (roughly the `#f7f5f0` to `#f4f1ea` range), with `inset` a step darker.
- `ink`: pen-ink black (around `#1a1a1c`). `muted`, `muted-hi`: graphite grays.
- `hairline`, `divider`: staff-line gray.
- **Edge colours:** darker versions of all six that reach **WCAG 3:1 against the paper canvas** for lines and **4.5:1** wherever an edge colour is used for text. Keep each hue recognizable next to its dark-mode counterpart.
- **Glass** becomes frosted paper: surface at high opacity, with a softer, shorter, lower-alpha shadow than dark mode's.

Deliverable: the new mode, plus a page showing a contrast table for every text/background pair, and the J1 journey header rendered in both modes side by side. **Daniel signs off before step 2.**

## Step 2: tokens and switcher (code)

- `src/styles/tokens.css`: keep the `@theme` block as the dark default. Add `:root[data-theme="light"] { … }` overriding the same custom properties. **Components must not branch on theme**: any inline colour still left in pre-design-pass components gets converted to tokens in this work (list them in the PR).
- Setting: **dark / light / follow system**. Follow system uses `prefers-color-scheme` on the web, and in Tauri the window theme API with its theme-changed event. It's stored per device, not per account (a work laptop and a phone can differ).
- The sigma canvas: node, edge and label colours come from the same tokens. Read them at render time, and refresh sigma's settings when the theme changes, without re-running the layout.
- Wordmark: `src/assets/brand/black-wordmark.svg` in light mode. `index.html` sets `data-theme` before first paint (a small inline script) so a light-mode user never sees a dark flash.
- Update DESIGN.md: replace "one dark theme, no light mode" with the two-theme model and the paper rationale.

## Done when

Every surface in the app looks intentional in both themes (screenshot pairs in the PR). Contrast checks pass. Follow-system switches live without a reload.
