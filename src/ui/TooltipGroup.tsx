import { useMemo, useRef, type ReactNode } from 'react'
import { TooltipGroupContext, type TooltipGroupApi } from './tooltipGroupContext'

/* Backs Tooltip.tsx's "hot" behavior (see that file's header comment): the
 * macOS Dock / VS Code activity-bar pattern where a sibling trigger skips
 * its own dwell if a tooltip in the same group was *just* dismissed, so
 * sweeping the pointer across a row of icons reads as one continuous
 * tooltip instead of N independent 400ms waits. A ref, not state — the
 * timestamp only ever needs to be read by the next pointerenter, never
 * needs to cause a render of its own. */
export function TooltipGroup({ children }: { children: ReactNode }) {
  const lastDismissedAt = useRef<number | null>(null)
  const api = useMemo<TooltipGroupApi>(
    () => ({
      markDismissed: () => {
        lastDismissedAt.current = Date.now()
      },
      dismissedWithin: (withinMs) =>
        lastDismissedAt.current != null && Date.now() - lastDismissedAt.current < withinMs,
    }),
    [],
  )
  return <TooltipGroupContext.Provider value={api}>{children}</TooltipGroupContext.Provider>
}
