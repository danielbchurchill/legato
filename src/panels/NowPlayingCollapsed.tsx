import { CoverArt } from '../ui/CoverArt'
import { ScrollingText } from '../ui/ScrollingText'
import { useNodeDetail } from './useNodeDetail'

/* v2's collapsed right panel content — DESIGN.md "Panel collapsed (v2)":
 * a 194x194 cover and a three-line title/album/artist block at a 24px line
 * pitch, nothing else — no metadata, lyrics, connections or notes, collapsed
 * or otherwise. Deliberately not NodeTitleBlock reused as-is: that one
 * targets the expanded panel's rhythm (2px line gap, no fixed pitch), and
 * this state calls out its own 24px number explicitly. */

export function NowPlayingCollapsed({ nodeId }: { nodeId: number | null }) {
  const { node } = useNodeDetail(nodeId)

  if (nodeId == null || !node) {
    return null
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
