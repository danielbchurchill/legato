import { useEffect, useRef, type RefObject } from 'react'
import type Sigma from 'sigma'

/* Pins a DOM overlay to a node on the WebGL canvas.
 *
 * The hover plate and the selected-node card are real DOM — they are glass,
 * and backdrop-filter has no equivalent inside sigma's renderer. So they live
 * in a layer over the canvas and have to be told where their node currently
 * is, in viewport pixels, on every frame that could have moved it.
 *
 * 'afterRender' is the subscription rather than the camera's own 'updated'
 * because a node moves for more reasons than the camera: dragging one
 * rewrites its graph coordinates without touching the camera at all, and a
 * background resync can move it under a stationary viewport. sigma renders on
 * demand, not on a loop, so this fires exactly when something changed and not
 * once a frame forever.
 *
 * Position is written straight to the element's style rather than through
 * React state: the contents of these overlays change once per selection, and
 * re-rendering a cover and three data rows on every frame of a camera fly
 * would be work done for nothing. */

export type NodeAnchor = {
  /** Node centre, in pixels from the canvas's top-left corner. */
  x: number
  y: number
  /** The node's on-screen radius in pixels at the camera's current zoom. */
  radiusPx: number
}

export function useNodeAnchor(
  renderer: Sigma | null,
  nodeKey: string | null,
  place: (element: HTMLDivElement, anchor: NodeAnchor) => void,
): RefObject<HTMLDivElement | null> {
  const elementRef = useRef<HTMLDivElement>(null)

  // Held in a ref so an inline arrow at the call site doesn't resubscribe the
  // listener on every parent render.
  const placeRef = useRef(place)
  useEffect(() => {
    placeRef.current = place
  })

  useEffect(() => {
    const element = elementRef.current
    if (!renderer || !element || nodeKey == null) return

    const update = () => {
      // Absent while a granularity switch is mid-flight, or for the one frame
      // after a resync drops a node that no longer qualifies. Hidden rather
      // than left at a stale position — an overlay pinned to where a node
      // used to be is worse than no overlay.
      const display = renderer.getNodeDisplayData(nodeKey)
      if (!display) {
        element.style.visibility = 'hidden'
        return
      }
      const { x, y } = renderer.framedGraphToViewport(display)
      element.style.visibility = ''
      // scaleSize rather than deriving the radius from the camera ratio by
      // hand: it is sigma's own answer, so it stays correct through
      // zoomToSizeRatioFunction and itemSizesReference without this file
      // needing to know either of them.
      placeRef.current(element, { x, y, radiusPx: renderer.scaleSize(display.size) })
    }

    update()
    renderer.on('afterRender', update)
    return () => {
      renderer.off('afterRender', update)
    }
  }, [renderer, nodeKey])

  return elementRef
}
