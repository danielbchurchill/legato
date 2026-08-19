import { CoverArt } from '../ui/CoverArt'
import { SectionHeader } from '../ui/DataRow'
import { NodeDetailPages } from './NodeDetailPages'
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
 * card's three rows opens as the inspector modal. What is left here is the
 * cover, who it is, what is coming next, and NodeDetailPages for the rest —
 * the same component the inspector renders, so a track's metadata reads
 * identically whichever way you arrived at it.
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
       * playback rather than about the node. */}
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

      <NodeDetailPages
        node={node}
        reload={reload}
        isPlaying={isPlaying}
        onSelectNode={onSelectNode}
        onPlay={onPlay}
      />
    </div>
  )
}
