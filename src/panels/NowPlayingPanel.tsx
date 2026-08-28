import { CoverArt } from '../ui/CoverArt'
import { SectionHeader } from '../ui/DataRow'
import { AboutDisclosure, ConnectionsDisclosure, LyricsDisclosure, NotesDisclosure, TrackMetadataDisclosure } from './NowPlayingSections'
import { NodeTitleBlock } from './NodeTitleBlock'
import { useNodeDetail } from './useNodeDetail'
import type { QueueEntry } from '../playback/usePlayback'

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

type NowPlayingPanelProps = {
  nodeId: number | null
  isPlaying: boolean
  upNext: QueueEntry[]
  onSelectNode: (id: number) => void
  onPlay: (nodeId: number, title: string) => void
}

export function NowPlayingPanel({ nodeId, isPlaying, upNext, onSelectNode, onPlay }: NowPlayingPanelProps) {
  const { node, reload } = useNodeDetail(nodeId)

  if (nodeId == null || !node) {
    return (
      <p className="pt-[40px] text-center text-[length:var(--text-base)] text-[var(--color-muted)]">
        nothing playing
      </p>
    )
  }

  return (
    <div className="flex flex-col">
      <CoverArt nodeId={node.id} size="full" alt={`Cover art for ${node.title}`} className="aspect-square w-full" />

      <NodeTitleBlock node={node} />

      {/* P-7: always present and expanded when non-empty, not hidden behind
       * a chevron. The one piece of this panel that is genuinely about
       * playback rather than about the node. Kept exactly where it sat
       * before the disclosure restructure — least disruptive to the new
       * stack below it — since nothing in v2's Detail Panel frames shows
       * "up next" at all. Real, working functionality (P-7), so this is
       * carried forward rather than cut, but its existence and position
       * here are this session's judgment call, not a confirmed part of the
       * v2 design; flagging for Daniel to confirm. */}
      {upNext.length > 0 && (
        <div className="mt-[15px]">
          <SectionHeader title="up next" />
          <ul className="mt-[8px] flex flex-col">
            {upNext.map((entry) => (
              <li key={entry.recordingNodeId}>
                <button
                  type="button"
                  onClick={() => onSelectNode(entry.recordingNodeId)}
                  className="w-full truncate py-[4px] text-left font-[family-name:var(--font-mono)] text-[length:var(--text-base)] text-[var(--color-muted)] transition-colors duration-150 hover:text-[var(--color-muted-hi)]"
                >
                  {entry.title}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

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
