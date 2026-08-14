import type { ReactNode } from 'react'
import { ResizeHandles } from './ResizeHandles'
import { Titlebar } from './Titlebar'

/* The frame: titlebar, then a single stage that everything else floats on.
 *
 * The stage is the graph. Panels and the transport are absolutely positioned
 * over it rather than laid out beside it, because the canvas running edge to
 * edge underneath the glass is the design (DESIGN.md "The idea"). Nothing here
 * should ever become a column in a row of columns. */

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-[var(--color-canvas)]">
      <Titlebar />
      <main className="relative min-h-0 flex-1">{children}</main>
      <ResizeHandles />
    </div>
  )
}
