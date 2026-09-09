import { CoverArt } from '../ui/CoverArt'
import { Icon } from '../ui/Icon'
import { ScrollingText } from '../ui/ScrollingText'
import { Tooltip } from '../ui/Tooltip'
import { useNodeDetail } from './useNodeDetail'

/* v2's collapsed right panel content — DESIGN.md "Panel collapsed (v2)":
 * a 194x194 cover and a three-line title/album/artist block at a 24px line
 * pitch, nothing else — no metadata, lyrics, connections or notes, collapsed
 * or otherwise. Deliberately not NodeTitleBlock reused as-is: that one
 * targets the expanded panel's rhythm (2px line gap, no fixed pitch), and
 * this state calls out its own 24px number explicitly.
 *
 * #57: nodeId == null now means two different things, not one. RightPanel
 * only ever passes null here for the auto-collapsed *idle* case (nothing
 * queued at all) — a node that's merely still loading never reaches this
 * component in the first place, since RightPanel's collapsed branch is
 * driven off playback.status.currentRecordingNodeId, not a fetch. onQuickPlay
 * is only present for that idle case (RightPanel omits it once something's
 * actually playing), which is what selects the empty-state branch below
 * rather than a loading spinner. */

export function NowPlayingCollapsed({ nodeId, onQuickPlay }: { nodeId: number | null; onQuickPlay?: () => void }) {
  const { node } = useNodeDetail(nodeId)

  if (nodeId == null || !node) {
    if (!onQuickPlay) return null

    return (
      <div className="flex flex-col items-center gap-[12px] pt-[24px] text-center">
        <p className="font-[family-name:var(--font-ui)] text-[length:var(--text-base)] text-[var(--color-muted)]">
          nothing playing
        </p>
        <Tooltip label="Play something random">
          <button
            type="button"
            onClick={onQuickPlay}
            aria-label="Play a random track from your library"
            className="grid size-[48px] place-items-center rounded-full text-[var(--color-signal)] transition-opacity duration-150 hover:opacity-80"
          >
            <Icon name="play" size={24} />
          </button>
        </Tooltip>
      </div>
    )
  }

  const artist = node.edges.find((e) => e.direction === 'out' && e.type === 'performed_by')
  const album = node.edges.find((e) => e.direction === 'out' && e.type === 'appears_on')
  const lines =
    node.type === 'recording'
      ? [node.title, album?.other_title, artist?.other_title].filter((line): line is string => Boolean(line))
      : [node.title]

  return (
    <div className="flex flex-col items-center">
      <CoverArt nodeId={node.id} size="full" alt={`Cover art for ${node.title}`} className="size-[194px] shrink-0" />
      <div className="mt-[12px] flex w-full flex-col items-center text-center">
        {lines.map((line, i) => (
          <ScrollingText
            key={i}
            text={line}
            className="w-full font-[family-name:var(--font-mono)] text-[length:var(--text-base)] leading-[24px] text-[var(--color-ink)]"
          />
        ))}
      </div>
    </div>
  )
}
