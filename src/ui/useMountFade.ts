import { useEffect, useState } from 'react'

/* Returns false on the frame something mounts and true from the next one, so
 * a CSS opacity transition has two different paints to run between. Without
 * the frame's delay the element is painted once, already at its final
 * opacity, and the transition never fires.
 *
 * Shared by everything that arrives over the canvas rather than being there
 * all along — the hover plate, the selected-node card, the tooltip. Pair it
 * with a transition-opacity utility and drive `style.opacity` from the
 * result; opacity is also the one channel DESIGN.md keeps under reduced
 * motion, so nothing here needs a motion-reduce escape hatch. */
export function useMountFade(active = true): boolean {
  const [shown, setShown] = useState(false)
  // Reset during render, not in the effect: going inactive reads as hidden
  // on that same render, and the next activation starts from false again,
  // so it still gets its one frame to fade in from.
  if (!active && shown) setShown(false)

  useEffect(() => {
    if (!active) return
    const raf = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(raf)
  }, [active])

  return active && shown
}
