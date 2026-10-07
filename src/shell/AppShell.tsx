import type { ReactNode } from 'react'

/* The frame: a single stage that everything else floats on.
 *
 * The stage is the map (or the library). The rail, capsule, side panels,
 * player and search palette are absolutely positioned over it rather than
 * laid out beside it, because the stage running edge to edge underneath the
 * glass is the design (DESIGN.md "The idea"). Nothing here should ever become
 * a column in a row of columns. */

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="fixed inset-0 overflow-hidden bg-[var(--color-canvas)]">
      <main className="relative h-full w-full">{children}</main>
    </div>
  )
}
