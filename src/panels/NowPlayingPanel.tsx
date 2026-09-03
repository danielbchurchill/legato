import { useEffect, useRef } from 'react'
import { CoverArt } from '../ui/CoverArt'
import { SectionHeader } from '../ui/DataRow'
import { Icon } from '../ui/Icon'
import { ScrollingText } from '../ui/ScrollingText'
import { Tooltip } from '../ui/Tooltip'
import { AboutDisclosure, ConnectionsDisclosure, LyricsDisclosure, NotesDisclosure, TrackMetadataDisclosure } from './NowPlayingSections'
import { NodeTitleBlock } from './NodeTitleBlock'
import { useNodeDetail } from './useNodeDetail'
import type { QueueEntry, usePlayback } from '../playback/usePlayback'

/* The right-hand panel, and it only ever means one thing now: what is
 * playing.
 *
 * It used to double as the select state — selecting any node on the canvas
 * re-titled this panel and swapped its node, so looking at something meant
 * losing sight of what was playing for as long as you looked. Selection moved
 * onto the graph itself (canvas/NodeCard.tsx), and everything deeper than the
 * card's three rows opens as the inspector modal (NodeInspector.tsx), which
 * still uses NodeDetailPages' paginated layout unchanged.
 *
 * This panel stopped sharing that pager with the modal once v2's Detail
 * Panel mockup called for stacked Disclosure sections instead (track
 * metadata / lyrics / connections / notes — NowPlayingSections.tsx). The
 * underlying data and logic (facts, edges, lyrics fetch, the edit -> dry-run
 * -> approve flow) is still one shared implementation — see
 * MetadataFields.tsx, ConnectionsContent.tsx, useLyrics.ts and
 * useMetadataEditing.ts — only the layout diverged, since a modal over the
 * canvas and a panel that's always present read differently and nothing in
 * DESIGN.md or the Figma frames said the modal should change too.
 *
 * P-5 still holds where it was actually about playback: isPlaying is an
 * attribute of the node being shown, not a fork into a separate component. */

type QueuePlayback = Pick<ReturnType<typeof usePlayback>, 'removeFromQueue' | 'reorderQueue' | 'next'>

type NowPlayingPanelProps = {
  nodeId: number | null
  isPlaying: boolean
  upNext: QueueEntry[]
  // Mirrors usePlayback's queueBusy — true while a next/previous/shuffle/
  // reorder/remove/add call is in flight anywhere (they all serialize
  // behind one shared lock, see usePlayback.ts). jumpTo below fires a
  // sequential run of next() calls with no guard of its own otherwise,
  // so a second click here before the first jumpTo finishes would just
  // queue more next() calls behind it and overshoot past the intended
  // row — same "no busy-state guard on async work" bug TransportDock had.
  queueBusy: boolean
  onSelectNode: (id: number) => void
  onPlay: (nodeId: number, title: string) => void
  queuePlayback: QueuePlayback
}

/* usePlayback.ts's removeFromQueue/reorderQueue both take an index into the
 * *whole* internal play sequence (must be > its own private currentIndex),
 * but the hook exposes no queue-position number of its own — only `upNext`,
 * the tail already sliced from it. This tracks that offset locally by
 * watching `nodeId` transitions: landing on what was `upNext[0]` a moment
 * ago is a natural forward step (+1); landing on anything else is a fresh
 * queue starting over (playNode/playAlbum/playPlaylist/playTracks all reset
 * the hook's own currentIndex to 0), so this resets to match. Holds up for
 * every advance this panel can cause (the jump-to-row workaround below,
 * repeated next() calls) and for auto-advance at a track's end; it does not
 * (and cannot, without the hook exposing its own position) account for a
 * previous() call from elsewhere. A `currentIndex`/`queuePosition` export —
 * or upNext-relative remove/reorder variants — would let this whole effect
 * go away; flagged in the PR rather than touched here, since usePlayback.ts
 * is out of scope for this change. */
function useQueuePosition(nodeId: number | null, upNext: QueueEntry[]): number {
  const positionRef = useRef(0)
  const prevNodeIdRef = useRef<number | null>(null)
  const prevUpNextRef = useRef<QueueEntry[]>([])

  useEffect(() => {
    if (nodeId !== prevNodeIdRef.current) {
      const advanced = prevUpNextRef.current[0]?.recordingNodeId === nodeId
      positionRef.current = advanced ? positionRef.current + 1 : 0
      prevNodeIdRef.current = nodeId
    }
    prevUpNextRef.current = upNext
  }, [nodeId, upNext])

  return positionRef.current
}

export function NowPlayingPanel({ nodeId, isPlaying, upNext, queueBusy, onSelectNode, onPlay, queuePlayback }: NowPlayingPanelProps) {
  const { node, reload } = useNodeDetail(nodeId)
  const queuePosition = useQueuePosition(nodeId, upNext)

  if (nodeId == null || !node) {
    return (
      <p className="pt-[40px] text-center text-[length:var(--text-base)] text-[var(--color-muted)]">
        nothing playing
      </p>
    )
  }

  const absoluteIndex = (upNextIndex: number) => queuePosition + 1 + upNextIndex

  // No direct "jump to index N" export — see the module comment above.
  // Repeated next() calls need no absolute index at all, unlike
  // removeFromQueue/reorderQueue below, which is what makes this the safe
  // choice here even though it walks the queue one track at a time.
  const jumpTo = async (upNextIndex: number) => {
    for (let i = 0; i <= upNextIndex; i++) await queuePlayback.next()
  }

  return (
    <div className="flex flex-col">
      <CoverArt nodeId={node.id} size="full" alt={`Cover art for ${node.title}`} className="aspect-square w-full" />

      <NodeTitleBlock node={node} />

      {/* P-7: always present, not hidden behind a chevron. The one piece of
       * this panel that is genuinely about playback rather than about the
       * node. Kept exactly where it sat before the disclosure restructure —
       * least disruptive to the new stack below it — since nothing in v2's
       * Detail Panel frames shows "up next" at all. Real, working queue
       * management (reorder/remove/jump), not just a read-only list, so
       * this is carried forward rather than cut, but its existence and
       * position here are this session's judgment call, not a confirmed
       * part of the v2 design; flagging for Daniel to confirm. */}
      <div className="mt-[15px]">
        <SectionHeader title="up next" />
        {upNext.length === 0 ? (
          <p className="pt-[8px] text-center text-[length:var(--text-base)] text-[var(--color-muted)]">Queue is empty</p>
        ) : (
          <ul className="mt-[8px] flex flex-col">
            {upNext.map((entry, i) => (
              <li key={`${entry.recordingNodeId}-${i}`} className="flex items-center gap-[4px] py-[2px]">
                <button
                  type="button"
                  onClick={() => void jumpTo(i)}
                  disabled={queueBusy}
                  className="min-w-0 flex-1 text-left text-[var(--color-muted)] transition-colors duration-150 hover:text-[var(--color-muted-hi)] disabled:pointer-events-none disabled:opacity-50"
                >
                  <ScrollingText text={entry.title} className="font-[family-name:var(--font-mono)] text-[length:var(--text-base)]" />
                </button>
                <Tooltip label="Move up">
                  <button
                    type="button"
                    onClick={() => void queuePlayback.reorderQueue(absoluteIndex(i), absoluteIndex(i - 1))}
                    disabled={i === 0 || queueBusy}
                    aria-label="Move up"
                    className="shrink-0 text-[var(--color-muted)] transition-colors duration-150 hover:text-[var(--color-muted-hi)] disabled:pointer-events-none disabled:opacity-30"
                  >
                    <Icon name="chevron-up" size={16} />
                  </button>
                </Tooltip>
                <Tooltip label="Move down">
                  <button
                    type="button"
                    onClick={() => void queuePlayback.reorderQueue(absoluteIndex(i), absoluteIndex(i + 1))}
                    disabled={i === upNext.length - 1 || queueBusy}
                    aria-label="Move down"
                    className="shrink-0 text-[var(--color-muted)] transition-colors duration-150 hover:text-[var(--color-muted-hi)] disabled:pointer-events-none disabled:opacity-30"
                  >
                    <Icon name="chevron-down" size={16} />
                  </button>
                </Tooltip>
                <Tooltip label="Remove from queue">
                  <button
                    type="button"
                    onClick={() => void queuePlayback.removeFromQueue(absoluteIndex(i))}
                    disabled={queueBusy}
                    aria-label="Remove from queue"
                    className="shrink-0 text-[var(--color-muted)] transition-colors duration-150 hover:text-[var(--color-muted-hi)] disabled:pointer-events-none disabled:opacity-30"
                  >
                    <Icon name="cancel" size={16} />
                  </button>
                </Tooltip>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* v2's five stacked sections. Order and open-by-default follow the
       * brief exactly for the four named ones (metadata open, the rest
       * closed); "about" is this session's own addition slotted in after
       * connections — see NowPlayingSections.tsx's top comment. */}
      <div className="mt-[15px] flex flex-col gap-[15px]">
        <TrackMetadataDisclosure node={node} reload={reload} isPlaying={isPlaying} onPlay={onPlay} />
        <LyricsDisclosure node={node} />
        <ConnectionsDisclosure node={node} reload={reload} onSelectNode={onSelectNode} />
        <AboutDisclosure node={node} onSelectNode={onSelectNode} />
        <NotesDisclosure />
      </div>
    </div>
  )
}
