import { useEffect, useRef, useState } from 'react'
import { SectionHeader } from '../ui/DataRow'
import { ArticleBody } from '../ui/ArticleBody'
import { Tooltip } from '../ui/Tooltip'
import { Icon } from '../ui/Icon'
import { FactGroupsList, IncomingRecordingsList, PersonalEdgesSection } from './ConnectionsContent'
import { LyricsContent } from './LyricsContent'
import { MbidBlock, MetadataActions, MetadataRows, InstancesList, PendingWriteReview } from './MetadataFields'
import { useLyrics } from './useLyrics'
import { useMetadataEditing } from './useMetadataEditing'
import type { FileRow, NodeDetail } from './useNodeDetail'

/* The on-canvas inspector modal's paginated node view (canvas/NodeCard.tsx
 * opens it via NodeInspector.tsx). This is the ONE surface in the app that
 * still paginates — the persistent Now Playing panel moved to stacked
 * Disclosure sections instead (NowPlayingSections.tsx) once v2's Detail
 * Panel mockup called for that, but nothing in DESIGN.md or the Figma
 * frames says the modal changes too, and pagination genuinely fits a modal
 * over the canvas differently than a persistent panel does. So this file
 * keeps paging, unchanged, while its content is now assembled from pieces
 * shared with the panel (MetadataFields.tsx, ConnectionsContent.tsx,
 * useLyrics.ts, useMetadataEditing.ts) rather than owning duplicate copies
 * of the same DataRows/facts/edit-flow logic — the metadata page below
 * composes those pieces in exactly the order this page rendered them
 * before the split, so its output is unchanged.
 *
 * Pagination — the dots at the foot — covers metadata, lyrics, and article.
 * Lyrics only applies to recording nodes (LRCLIB keys off title+artist) and
 * is fetched lazily (only once the lyrics page is actually opened, not
 * eagerly when a track starts) since GET /nodes/:id/lyrics is a real network
 * round trip to LRCLIB on a cache miss — see migration 0017's comment on why
 * that can't happen during a scan. */

type NodeDetailPagesProps = {
  node: NodeDetail
  reload: () => void
  /** Whether this node is the recording currently loaded in the transport —
   * playback as an attribute of the node being viewed, per P-5, rather than
   * a fork into a separate component. */
  isPlaying: boolean
  onSelectNode: (id: number) => void
  onPlay: (nodeId: number, title: string) => void
}

export function NodeDetailPages({ node, reload, isPlaying, onSelectNode, onPlay }: NodeDetailPagesProps) {
  const editingState = useMetadataEditing(node, reload)
  const [page, setPage] = useState(0)
  const swipeStartX = useRef<number | null>(null)

  // Reset the per-page view state whenever the node changes: a lyrics page
  // left open on the last track must not stay open, showing the last track's
  // lyrics, over a different one.
  useEffect(() => {
    setPage(0)
  }, [node.id])

  const pages: Array<'metadata' | 'lyrics' | 'article'> = [
    'metadata' as const,
    ...(node.type === 'recording' ? (['lyrics'] as const) : []),
    ...(node.article || node.description ? (['article'] as const) : []),
  ]

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (editingState.editing) return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      if (e.key === 'ArrowLeft') setPage((p) => Math.max(0, p - 1))
      if (e.key === 'ArrowRight') setPage((p) => Math.min(pages.length - 1, p + 1))
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingState.editing, pages.length])

  const { lyrics, lyricsWaitVisible, lyricsWaitLong } = useLyrics(node.id, pages[page] === 'lyrics')

  const file = node.files[0] as FileRow | undefined

  const handleSwipeStart = (e: React.PointerEvent) => {
    swipeStartX.current = e.clientX
  }
  const handleSwipeEnd = (e: React.PointerEvent) => {
    if (swipeStartX.current == null) return
    const delta = e.clientX - swipeStartX.current
    swipeStartX.current = null
    if (Math.abs(delta) < 40) return
    if (delta < 0) setPage((p) => Math.min(pages.length - 1, p + 1))
    else setPage((p) => Math.max(0, p - 1))
  }

  return (
    <div className="flex flex-col">
      {/* One horizontal track with every page mounted, translated by
       * -page * 100% (MO-3) — arrow keys, the dots and a swipe all produce
       * the same transition, and direction is what tells you which way you
       * went. Pages differ wildly in height (lyrics can run long); letting
       * the row stretch to the tallest mounted page is simpler than
       * measuring the active one and costs nothing since the panel already
       * owns the scroll. */}
      <div className="mt-[15px] overflow-hidden" onPointerDown={handleSwipeStart} onPointerUp={handleSwipeEnd}>
        <div
          className="flex transition-transform duration-[var(--motion-base)] ease-[var(--ease-out)] motion-reduce:transition-none"
          style={{ transform: `translateX(-${page * 100}%)` }}
        >
          {pages.includes('metadata') && (
            <div className="w-full shrink-0" inert={pages[page] !== 'metadata'}>
              <SectionHeader
                title="metadata"
                action={
                  !editingState.editing &&
                  !editingState.pendingWrite && (
                    <MetadataActions node={node} file={file} isPlaying={isPlaying} onPlay={onPlay} onEdit={editingState.startEditing} />
                  )
                }
              />

              <MetadataRows node={node} editingState={editingState} />

              <PendingWriteReview editingState={editingState} />

              <FactGroupsList facts={node.facts} onSelectNode={onSelectNode} />

              <IncomingRecordingsList node={node} onSelectNode={onSelectNode} />

              <MbidBlock node={node} />

              <InstancesList node={node} />

              <PersonalEdgesSection node={node} reload={reload} onSelectNode={onSelectNode} />
            </div>
          )}

          {pages.includes('lyrics') && (
            <div className="w-full shrink-0" inert={pages[page] !== 'lyrics'}>
              <SectionHeader title="lyrics" />
              <LyricsContent lyrics={lyrics} lyricsWaitVisible={lyricsWaitVisible} lyricsWaitLong={lyricsWaitLong} />
            </div>
          )}

          {pages.includes('article') && (
            <div className="w-full shrink-0" inert={pages[page] !== 'article'}>
              {/* Two kinds of prose on one page, in this order: who this is,
                * then what it is in *your* collection. The description comes
                * from outside (Wikipedia, via server/src/enrich/wikipedia.ts)
                * and is the same for everyone; the article below it is
                * generated from this library and is true of nobody else's. */}
              {node.description && (
                <>
                  <SectionHeader title="about" />
                  <p className="mt-[8px] text-[length:var(--text-base)] leading-relaxed text-[var(--color-ink)]">
                    {node.description.body}
                  </p>
                  {/* Attribution, not decoration: Wikipedia's text is CC BY-SA,
                    * so naming the source and its licence is an obligation the
                    * UI carries. The URL lives in the tooltip because this app
                    * has no way to open an external browser yet (no Tauri
                    * opener plugin) — a link that silently does nothing would
                    * be worse than text that can be read and typed. */}
                  <div className="mt-[8px] flex items-center gap-[6px] text-[length:var(--text-base)] text-[var(--color-muted)]">
                    <span>from {node.description.source}</span>
                    {node.description.license && <span>· {node.description.license}</span>}
                    {node.description.source_url && (
                      <Tooltip label={node.description.source_url} monospace>
                        <Icon name="info" size={16} />
                      </Tooltip>
                    )}
                  </div>
                </>
              )}
              {node.article && (
                <>
                  <SectionHeader title="article" />
                  <ArticleBody
                    bodyMd={node.article.body_md}
                    onSelectNode={onSelectNode}
                    className="mt-[8px] text-[length:var(--text-base)] leading-relaxed text-[var(--color-ink)]"
                  />
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* P-7: page dots sit at the panel's bottom edge in the mockup, not
       * directly under the title block — sticky rather than a Panel.tsx API
       * change, since the panel already owns the scrolling container. */}
      {pages.length > 1 && (
        <div className="sticky bottom-0 mt-[15px] flex justify-center gap-[6px] border-t border-[var(--color-divider)] bg-[var(--color-surface-flat)]/80 py-[12px] backdrop-blur-[var(--blur-glass)]">
          {pages.map((p, i) => (
            <button
              key={p}
              type="button"
              aria-label={`Page ${i + 1} of ${pages.length}: ${p}`}
              aria-current={i === page}
              onClick={() => setPage(i)}
              className={`h-[6px] w-[6px] rounded-full transition-colors duration-150 ${
                i === page ? 'bg-[var(--color-signal)]' : 'bg-[var(--color-hairline)]'
              }`}
            />
          ))}
        </div>
      )}
    </div>
  )
}
