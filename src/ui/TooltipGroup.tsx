import { createContext, useContext, useRef, type MutableRefObject, type ReactNode } from 'react'

/* Backs Tooltip.tsx's "hot" behavior (see that file's header comment): the
 * macOS Dock / VS Code activity-bar pattern where a sibling trigger skips
 * its own dwell if a tooltip in the same group was *just* dismissed, so
 * sweeping the pointer across a row of icons reads as one continuous
 * tooltip instead of N independent 400ms waits. A ref, not state — the
 * timestamp only ever needs to be read by the next pointerenter, never
 * needs to cause a render of its own. */

type TooltipGroupRef = MutableRefObject<number | null>

const TooltipGroupContext = createContext<TooltipGroupRef | null>(null)

export function TooltipGroup({ children }: { children: ReactNode }) {
  const lastDismissedAt = useRef<number | null>(null)
  return <TooltipGroupContext.Provider value={lastDismissedAt}>{children}</TooltipGroupContext.Provider>
}

/** null outside any TooltipGroup — Tooltip must keep working standalone
 * everywhere it isn't wrapped in one. */
export function useTooltipGroup(): TooltipGroupRef | null {
  return useContext(TooltipGroupContext)
}
