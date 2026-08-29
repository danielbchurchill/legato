import type { ReactNode } from 'react'

/* The frame: a single stage that everything else floats on.
 *
 * The stage is the graph. Headers, the rail, panels and the transport are
 * absolutely positioned over it rather than laid out beside it, because the
 * canvas running edge to edge underneath the glass is the design (DESIGN.md
 * "The idea"). Nothing here should ever become a column in a row of columns.
 *
 * v2 drops the old single continuous titlebar — LeftPanelHeader and
 * RightPanelHeader are two separate glass regions, each scoped to its own
 * side column, so the canvas between them now runs all the way to the
 * window's top edge with nothing reserved above it. See DESIGN.md's shell
 * section.
 *
 * The window runs with native OS decorations again (tauri.conf.json's
 * `decorations: true`), so the WM's own resize borders are back too —
 * ResizeHandles.tsx, the invisible edge-drag strips that stood in for them
 * while the window was frameless, is gone with it. */

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="fixed inset-0 overflow-hidden bg-[var(--color-canvas)]">
      <main className="relative h-full w-full">{children}</main>
    </div>
  )
}
