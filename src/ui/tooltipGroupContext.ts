import { createContext, useContext } from 'react'

/* The context half of TooltipGroup.tsx, kept out of that file so it only
 * exports a component (fast refresh needs that). Tooltips talk to the group
 * through these two calls rather than reaching into a shared ref, so the
 * timestamp's owner is the one place that writes it. */
export type TooltipGroupApi = {
  /** A tooltip in this group was just dismissed. */
  markDismissed: () => void
  /** Whether that happened within the last `withinMs`. */
  dismissedWithin: (withinMs: number) => boolean
}

export const TooltipGroupContext = createContext<TooltipGroupApi | null>(null)

/** null outside any TooltipGroup — Tooltip must keep working standalone
 * everywhere it isn't wrapped in one. */
export function useTooltipGroup(): TooltipGroupApi | null {
  return useContext(TooltipGroupContext)
}
