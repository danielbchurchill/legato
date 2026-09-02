import { useEffect, useState } from 'react'
import type Sigma from 'sigma'
import { Surface } from '../shell/Surface'
import { CoverArt } from '../ui/CoverArt'
import { DataRow, SectionHeader } from '../ui/DataRow'
import { Icon } from '../ui/Icon'
import { ScrollingText } from '../ui/ScrollingText'
import { Tooltip } from '../ui/Tooltip'
import { useMountFade } from '../ui/useMountFade'
import { formatDuration, formatLongDuration, NO_VALUE } from '../ui/format'
import { useNodeAnchor, type NodeAnchor } from './useNodeAnchor'
import { SERVER_HOST } from '../config/serverHost'
import type { usePlayback } from '../playback/usePlayback'

const API = `http://${SERVER_HOST}:8899/api/v1`

/* Figma frame 31:246 ("Selected"). The node you clicked, opened in place on
 * the canvas: its cover at 255px with a title block and three metadata rows
 * beside it.
 *
 * This replaces the old select state, which took over the right-hand panel
 * and pushed whatever was playing off screen for as long as anything was
 * selected. Selecting a node is now a thing that happens on the graph, where
 * the node is, and the now-playing panel goes back to only ever meaning now
 * playing.
 *
 * The card is anchored to its node and is not clamped to the canvas: near the
 * window's edge it will run under a panel. That is deliberate — clicking a
 * node also flies the camera to it, so the node the card belongs to is almost
 * always near the middle of the viewport by the time the card is readable,
 * and clamping would break the one thing the card is for by parking it
 * somewhere its node isn't.
 *
 * Its right-hand column is the app's existing panel rhythm at its existing
 * width — 314px of content, SectionHeader's 31px/16px header-to-rule, DataRow's
 * 33px pitch and 57/43 split. Nothing here is a second layout language. */

/* Geometry from the frame. These live in JS rather than as CSS tokens
 * because place() has to do arithmetic with them: the card is positioned by
 * where its *cover slot* lands, not by its own corner, so the cover's size
 * and the padding above and to the left of it are the same numbers in the
 * layout and in the transform. One source, applied through inline style. */
const COVER_PX = 255
const PAD_LEFT = 26
const PAD_TOP = 30
const PAD_RIGHT = 45
const PAD_BOTTOM = 27
const COLUMN_GAP = 25
const COLUMN_PX = 314

/* Read by Canvas.tsx to decide where the camera should land a node: the card
 * is anchored to its node, so the only way to keep the card out from under a
 * panel is to put the node somewhere the card fits. */
export const NODE_CARD_WIDTH_PX = PAD_LEFT + COVER_PX + COLUMN_GAP + COLUMN_PX + PAD_RIGHT
export const NODE_CARD_COVER_CENTER_X = PAD_LEFT + COVER_PX / 2
export const NODE_CARD_COVER_CENTER_Y = PAD_TOP + COVER_PX / 2

/* Duplicated from Canvas.tsx's own SELECT_NODE_PX rather than imported —
 * Canvas.tsx imports NodeCard, so importing back would be circular, and this
 * file already duplicates other cross-file constants (EDGE_COLOR-style) the
 * same way, kept in sync by hand. This is the node's on-screen width, in
 * pixels, at the zoom the camera flies to on selection — the reference the
 * card's own geometry above was measured against. */
const SELECT_NODE_PX = 130

/* Sanity bounds, not measured values: the camera has no zoom limits (see
 * Canvas.tsx), so an unclamped scale could shrink the card to nothing or
 * blow it up past readability at the extremes of a scroll-wheel zoom.
 *
 * MAX_CARD_SCALE was 2.5 — confirmed live that a realistic scroll-wheel
 * session hits it after only five or six notches,
 * well inside the camera's actually-reachable range: the card would freeze
 * solid while everything around it, edges and neighboring nodes included,
 * kept visibly growing, reading as "stopped getting bigger" rather than as
 * an intentional ceiling. radiusPx has no cap of its own (sigma's node
 * rendering never stops growing), so *some* limit still has to exist here —
 * a DOM element can't scale forever — but it needs enough headroom that a
 * normal zoom-in session runs out of interest in the graph around it before
 * it ever reaches this number. */
const MIN_CARD_SCALE = 0.4
const MAX_CARD_SCALE = 6

/* The card is real DOM with pointer-events: auto (its buttons need clicks),
 * sitting on top of sigma's canvas in a sibling layer — so a wheel event
 * over the card never reaches sigma's own listener at all; DOM events don't
 * cross from one sibling subtree to another. Confirmed live: scrolling with
 * the cursor left where it was right after the click that opened the card —
 * the single most natural way to zoom in on what you just selected — did
 * nothing whatsoever, not even a muted response.
 *
 * sigma.getContainer() is *not* the fix — it's the outer element passed to
 * the Sigma constructor, but MouseCaptor is wired to its own transparent
 * `sigma-mouse` canvas layered on top of the rendered ones
 * (mouseCaptor = new MouseCaptor(this.elements.mouse, this) in sigma's own
 * source), so a wheel dispatched at the outer container never reaches it
 * either — confirmed live the same way, by checking whether the listener's
 * own preventDefault ran. getMouseCaptor().container is that actual canvas,
 * public and typed despite the name. Its handler reads position via
 * getMouseCoords(e, this.container) — the event's clientX/Y against that
 * container's own bounding rect, not e.target — and has no isTrusted check,
 * so re-dispatching a synthetic wheel event there reproduces a real
 * over-canvas scroll exactly, coordinates included. */
function forwardWheelToCanvas(renderer: Sigma | null, e: React.WheelEvent<HTMLDivElement>): void {
  if (!renderer) return
  e.preventDefault()
  renderer.getMouseCaptor().container.dispatchEvent(
    new WheelEvent('wheel', {
      clientX: e.clientX,
      clientY: e.clientY,
      deltaX: e.deltaX,
      deltaY: e.deltaY,
      deltaMode: e.deltaMode,
      bubbles: true,
      cancelable: true,
    }),
  )
}

function place(element: HTMLDivElement, { x, y, radiusPx }: NodeAnchor): void {
  // The card's geometry is measured at SELECT_NODE_PX/2 radius (DESIGN.md's
  // fly-to zoom). Scrolling the camera in or out after selecting changes the
  // node's own on-screen radius but used to leave the card's size fixed, so
  // its 255px cover visibly stopped matching the node it was supposed to be
  // opening. Scaling by the same ratio keeps the card locked to its node at
  // any zoom, the same way NodeHoverPlate already does for its own geometry.
  const scale = Math.min(MAX_CARD_SCALE, Math.max(MIN_CARD_SCALE, radiusPx / (SELECT_NODE_PX / 2)))
  element.style.transformOrigin = `${NODE_CARD_COVER_CENTER_X}px ${NODE_CARD_COVER_CENTER_Y}px`
  element.style.transform =
    `translate(${x - NODE_CARD_COVER_CENTER_X}px, ${y - NODE_CARD_COVER_CENTER_Y}px) scale(${scale})`
}

/** Mirrors NodeSummary in server/src/summary.ts. */
type NodeSummary =
  | { kind: 'artist'; releases: number; tracks: number; topAlbum: { id: number; title: string } | null }
  | { kind: 'release'; tracks: number; totalDurationMs: number; releaseDate: string | null }
  | { kind: 'recording'; trackNo: number | null; durationMs: number | null; releaseDate: string | null }
  | { kind: 'other' }

// 'recording' is the schema's word; 'track' is the app's, and it is what the
// graph toggle and every panel already say.
const KIND_NOUN: Record<string, string> = { recording: 'track' }

function summaryRows(summary: NodeSummary): { label: string; value: string }[] {
  switch (summary.kind) {
    case 'artist':
      return [
        { label: 'releases', value: String(summary.releases) },
        { label: 'tracks', value: String(summary.tracks) },
        // Play-derived, so it has no answer at all until something has been
        // listened to. An em dash rather than a zero — see summary.ts.
        { label: 'top album', value: summary.topAlbum?.title ?? NO_VALUE },
      ]
    case 'release':
      return [
        { label: 'tracks', value: String(summary.tracks) },
        { label: 'length', value: formatLongDuration(summary.totalDurationMs) },
        { label: 'release date', value: summary.releaseDate ?? NO_VALUE },
      ]
    case 'recording':
      return [
        { label: 'track no.', value: summary.trackNo != null ? String(summary.trackNo) : NO_VALUE },
        { label: 'length', value: formatDuration(summary.durationMs) },
        { label: 'release date', value: summary.releaseDate ?? NO_VALUE },
      ]
    // label/year/work/credit nodes carry no aggregate worth three rows, so
    // the card is its title block and nothing else.
    case 'other':
      return []
  }
}

type Playback = Pick<ReturnType<typeof usePlayback>, 'playNode' | 'playAlbum'>

type NodeCardProps = {
  renderer: Sigma | null
  nodeId: number
  nodeKey: string
  type: string
  title: string
  subtitle: string | null
  onOpenInspector: () => void
  playback: Playback
}

export function NodeCard({ renderer, nodeId, nodeKey, type, title, subtitle, onOpenInspector, playback }: NodeCardProps) {
  const ref = useNodeAnchor(renderer, nodeKey, place)
  const shown = useMountFade()
  const [summary, setSummary] = useState<NodeSummary | null>(null)

  useEffect(() => {
    // Cheap enough to refetch per selection (a few indexed lookups server
    // side), and stale rows under a new cover would be worse than none.
    let cancelled = false
    setSummary(null)
    fetch(`${API}/nodes/${nodeId}/summary`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: NodeSummary | null) => {
        if (!cancelled) setSummary(data)
      })
      .catch(() => {
        if (!cancelled) setSummary(null)
      })
    return () => {
      cancelled = true
    }
  }, [nodeId])

  const rows = summary ? summaryRows(summary) : []

  return (
    <div ref={ref} className="absolute top-0 left-0" onWheel={(e) => forwardWheelToCanvas(renderer, e)}>
      <Surface
        className="relative flex transition-opacity duration-[var(--motion-base)] ease-[var(--ease-out)]"
        style={{
          gap: COLUMN_GAP,
          paddingTop: PAD_TOP,
          paddingRight: PAD_RIGHT,
          paddingBottom: PAD_BOTTOM,
          paddingLeft: PAD_LEFT,
          opacity: shown ? 1 : 0,
        }}
      >
        {/* Stretched hit target: the whole card opens the inspector, but the
         * pencil inside it needs to be its own button, and a button cannot
         * contain a button. Everything above this is pointer-events-none so
         * clicks fall through to it, except the pencil, which opts back in. */}
        <button
          type="button"
          onClick={onOpenInspector}
          aria-label={`Open ${title}`}
          className="absolute inset-0 rounded-[var(--radius-surface)]"
        />

        <CoverArt
          nodeId={nodeId}
          size="full"
          alt=""
          className="pointer-events-none relative shrink-0"
          // Square, no radius: artwork is reproduced, not restyled.
          style={{ width: COVER_PX, height: COVER_PX }}
        />

        <div className="pointer-events-none relative flex flex-col" style={{ width: COLUMN_PX }}>
          <p className="truncate text-[length:var(--text-base)] leading-[19px] text-[var(--color-muted)]">
            selected {KIND_NOUN[type] ?? type}
          </p>
          <ScrollingText
            text={title}
            className="mt-[17px] font-[family-name:var(--font-mono)] text-[length:var(--text-base)] leading-[19px] text-[var(--color-ink)]"
          />
          {/* Artist nodes have no second line. The cover sets the card's
            * height, so its absence shortens the column, not the card. */}
          {subtitle && (
            <ScrollingText
              text={subtitle}
              className="mt-[11px] font-[family-name:var(--font-mono)] text-[length:var(--text-base)] leading-[19px] text-[var(--color-ink)]"
            />
          )}

          {rows.length > 0 && (
            <div className="mt-[2px]">
              <SectionHeader
                title="metadata"
                action={
                  <div className="pointer-events-auto flex items-center gap-[12px]">
                    {(type === 'recording' || type === 'release') && (
                      <Tooltip label="Play">
                        <button
                          type="button"
                          onClick={() => (type === 'release' ? playback.playAlbum(nodeId) : playback.playNode(nodeId, title))}
                          aria-label="Play"
                          className="text-[var(--color-muted)] transition-colors duration-[var(--motion-fast)] ease-[var(--ease-out)] hover:text-[var(--color-muted-hi)]"
                        >
                          <Icon name="play" size={24} />
                        </button>
                      </Tooltip>
                    )}
                    <button
                      type="button"
                      onClick={onOpenInspector}
                      aria-label="Edit metadata"
                      className="text-[var(--color-muted)] transition-colors duration-[var(--motion-fast)] ease-[var(--ease-out)] hover:text-[var(--color-muted-hi)]"
                    >
                      <Icon name="pencil" size={24} />
                    </button>
                  </div>
                }
              />
              <div className="mt-[8px]">
                {rows.map((row) => (
                  <DataRow key={row.label} label={row.label} value={row.value} />
                ))}
              </div>
            </div>
          )}
        </div>
      </Surface>
    </div>
  )
}
