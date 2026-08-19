import type { NodeDetail } from './useNodeDetail'

/* P-7: the mockup's title block is three centred lines — title, album,
 * artist — not two left-aligned lines joined by an em dash. Non-recording
 * nodes have no album/artist edges, so they fall back to a centred type
 * label.
 *
 * Shared by the now-playing panel and the inspector modal: the same node has
 * to be named the same way whichever surface is showing it. */
export function NodeTitleBlock({ node }: { node: NodeDetail }) {
  const artist = node.edges.find((e) => e.direction === 'out' && e.type === 'performed_by')
  const album = node.edges.find((e) => e.direction === 'out' && e.type === 'appears_on')

  return (
    <div className="mt-[12px] flex flex-col items-center gap-[2px] text-center">
      <p className="w-full truncate font-[family-name:var(--font-mono)] text-[length:var(--text-base)] text-[var(--color-ink)]">
        {node.title}
      </p>
      {node.type === 'recording' ? (
        <>
          {album && (
            <p className="w-full truncate font-[family-name:var(--font-mono)] text-[length:var(--text-base)] text-[var(--color-ink)]">
              {album.other_title}
            </p>
          )}
          {artist && (
            <p className="w-full truncate font-[family-name:var(--font-mono)] text-[length:var(--text-base)] text-[var(--color-ink)]">
              {artist.other_title}
            </p>
          )}
        </>
      ) : (
        <p className="text-[length:var(--text-base)] text-[var(--color-muted)]">{node.type}</p>
      )}
    </div>
  )
}
