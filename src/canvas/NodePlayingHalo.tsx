import type Sigma from 'sigma'
import { useNodeAnchor, type NodeAnchor } from './useNodeAnchor'

/* Issue #85: the transport can be playing a track the user isn't looking at
 * at all — the selection card only ever marks whatever was clicked, and the
 * two are frequently different nodes (browsing the graph while a track
 * keeps running in the background). This is a second, independent in-place
 * state, the same idea as the hover plate and the selection card (DESIGN.md
 * "In place on a node": both are DOM overlays pinned to a node rather than a
 * change to the node's own rendering) but keyed off playback instead of
 * pointer/click.
 *
 * "Currently playing" here matches App.tsx's own anchorNodeId precedent —
 * status.currentRecordingNodeId, not gated on status.playing — so the halo
 * marks the transport's loaded track the same way the now-playing panel
 * does, pausing the audio doesn't make the halo vanish and reappear.
 *
 * The one deliberate exception to DESIGN.md Motion's "nothing animates on a
 * loop": that rule targets decoration, and this isn't one — playback is
 * itself an ongoing state for as long as a track runs, and a static
 * highlight would read as "selected", not "playing" (the same distinction
 * the bounded exceptions for progress and marquee overflow already carve
 * out for their own non-decorative cases). Built as a real CSS @keyframes
 * animation (tokens.css) rather than one of this file's sibling rAF loops
 * specifically so it falls under index.css's existing reduced-motion rule
 * (animation-duration/iteration-count zeroed under prefers-reduced-motion or
 * the settings override) for free: no bespoke reduced-motion branch here,
 * and the frozen frame lands on the resting 40% opacity end of the loop, a
 * plain static halo rather than losing the cue outright.
 *
 * If this node also happens to be selected, NodeCard's 255px cover
 * (rendered after this in Canvas.tsx's overlay stack) sits on top and can
 * fully cover a small halo — same fate the old selection ring already met
 * for the same reason (DESIGN.md "Nodes"). That's fine here too: a selected,
 * playing node already shows everything about itself on the card, so the
 * halo underneath has nothing left to add. */

// Recording nodes — the only node type that can ever be "playing" — are
// never square (SQUARE_COVER_TYPES in Canvas.tsx is releases only), so
// unlike useNodeAnchor's own radius math this can stay a plain circle
// without reading the node's `square` attribute.
const HALO_CLEARANCE_RATIO = 0.3 // proportion of the node's own on-screen radius
const HALO_CLEARANCE_MIN_PX = 6 // stays visible even on a barely-rendered node at whole-library zoom

function place(element: HTMLDivElement, { x, y, radiusPx }: NodeAnchor): void {
  const clearance = Math.max(HALO_CLEARANCE_MIN_PX, radiusPx * HALO_CLEARANCE_RATIO)
  const diameter = (radiusPx + clearance) * 2
  element.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px)`
  element.style.width = `${diameter}px`
  element.style.height = `${diameter}px`
}

type NodePlayingHaloProps = {
  renderer: Sigma | null
  nodeKey: string
}

export function NodePlayingHalo({ renderer, nodeKey }: NodePlayingHaloProps) {
  const ref = useNodeAnchor(renderer, nodeKey, place)

  return (
    <div
      ref={ref}
      className="pointer-events-none absolute top-0 left-0 rounded-full animate-[node-halo-pulse_var(--motion-pulse)_var(--ease-inout)_infinite]"
      style={{
        boxShadow: '0 0 0 1.5px var(--color-signal), 0 0 18px 4px var(--color-signal)',
      }}
    />
  )
}
