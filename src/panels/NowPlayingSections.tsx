import { useState } from 'react'
import { Disclosure } from '../ui/Disclosure'
import { Icon } from '../ui/Icon'
import { SectionHeader } from '../ui/DataRow'
import { Tooltip } from '../ui/Tooltip'
import { ArticleBody } from '../ui/ArticleBody'
import { ConnectionsBody } from './ConnectionsContent'
import { LyricsContent } from './LyricsContent'
import { MbidBlock, MetadataActions, MetadataRows, InstancesList, PendingWriteReview } from './MetadataFields'
import { DataRow } from '../ui/DataRow'
import { useLyrics } from './useLyrics'
import { useMetadataEditing } from './useMetadataEditing'
import type { FileRow, NodeDetail } from './useNodeDetail'

/* The persistent Now Playing panel's five stacked sections, per v2's Detail
 * Panel mockup (DESIGN.md, Figma frames Search/Music Map). Each of these
 * owns its own <Disclosure> and composes the same content pieces
 * NodeDetailPages.tsx uses for the paginated inspector modal
 * (MetadataFields.tsx, ConnectionsContent.tsx, useLyrics.ts,
 * useMetadataEditing.ts) — nothing here reimplements facts/edges rendering,
 * the edit -> dry-run -> approve flow, or the lyrics fetch; it only decides
 * which pieces go behind which disclosure and in what order.
 *
 * Field split for "track metadata" (flagged in the session's own summary,
 * not silently decided): the Figma mockup's row list mixes two different
 * kinds of data — literal file-tag metadata (plays, length, bpm, label,
 * release date/type) and graph-relationship data (release, year,
 * production, engineering, artists). The former are real scalar fields on
 * `files`/`recordings` and land here as DataRows. The latter don't exist as
 * flat fields at all — they're edges/facts already rendered by
 * groupFacts/FactGroup/FactLine — and the brief's own instruction for
 * "connections" says to reuse that logic rather than reinvent it, so they
 * render there instead of being duplicated as flat rows here.
 *
 * "about" (Wikipedia description + generated article) is this file's one
 * genuine addition beyond the mockup's named sections — real, working,
 * CC BY-SA-attributed content the pager still shows, with no evidence
 * either way on whether v2 dropped it or just hasn't gotten to it yet.
 * Kept rather than silently cut, same treatment as "up next" gets in
 * NowPlayingPanel.tsx, and flagged the same way. */

export function TrackMetadataDisclosure({
  node,
  reload,
  isPlaying,
  queueBusy,
  onPlay,
}: {
  node: NodeDetail
  reload: () => void
  isPlaying: boolean
  queueBusy: boolean
  onPlay: (nodeId: number, title: string) => void
}) {
  const editingState = useMetadataEditing(node, reload)
  const file = node.files[0] as FileRow | undefined

  return (
    <Disclosure
      title="track metadata"
      defaultOpen
      action={
        !editingState.editing &&
        !editingState.pendingWrite && (
          <MetadataActions
            node={node}
            file={file}
            isPlaying={isPlaying}
            queueBusy={queueBusy}
            onPlay={onPlay}
            onEdit={editingState.startEditing}
          />
        )
      }
    >
      <MetadataRows
        node={node}
        editingState={editingState}
        extraRows={node.playCount != null && <DataRow label="plays" value={node.playCount} />}
      />
      <PendingWriteReview editingState={editingState} />
      <MbidBlock node={node} />
      <InstancesList node={node} />
    </Disclosure>
  )
}

export function LyricsDisclosure({ node }: { node: NodeDetail }) {
  // Controlled, not defaultOpen: useLyrics needs to know when this section
  // is actually open to gate the fetch (a closed disclosure that's never
  // opened must never call GET /nodes/:id/lyrics). Deliberately not reset
  // on node change the way the pager resets its page index — leaving
  // lyrics open across a track change and letting it load the new track's
  // lyrics reads as more useful in a persistent panel than snapping shut
  // every skip; useLyrics.ts already guarantees it never shows stale
  // content for the wrong node either way.
  const [open, setOpen] = useState(false)
  const { lyrics, lyricsWaitVisible, lyricsWaitLong } = useLyrics(node.id, open)

  if (node.type !== 'recording') return null

  return (
    <Disclosure title="lyrics" open={open} onOpenChange={setOpen}>
      <LyricsContent lyrics={lyrics} lyricsWaitVisible={lyricsWaitVisible} lyricsWaitLong={lyricsWaitLong} />
    </Disclosure>
  )
}

export function ConnectionsDisclosure({
  node,
  reload,
  onSelectNode,
}: {
  node: NodeDetail
  reload: () => void
  onSelectNode: (id: number) => void
}) {
  return (
    <Disclosure title="connections">
      <ConnectionsBody node={node} reload={reload} onSelectNode={onSelectNode} />
    </Disclosure>
  )
}

export function AboutDisclosure({ node, onSelectNode }: { node: NodeDetail; onSelectNode: (id: number) => void }) {
  if (!node.description && !node.article) return null
  return (
    <Disclosure title="about">
      {node.description && (
        <>
          <p className="text-[length:var(--text-base)] leading-relaxed text-[var(--color-ink)]">{node.description.body}</p>
          <div className="mt-[8px] flex items-center gap-[6px] text-[length:var(--text-base)] text-[var(--color-muted)]">
            <span>from {node.description.source}</span>
            {node.description.license && <span>· {node.description.license}</span>}
            {node.description.source_url && (
              <Tooltip label={node.description.source_url}>
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
    </Disclosure>
  )
}

export function NotesDisclosure() {
  // No backend at all yet — no table, no route. Shell only, per DESIGN.md's
  // empty-state pattern: muted, centered, one sentence, no illustration.
  return (
    <Disclosure title="notes">
      <p className="text-center text-[length:var(--text-base)] text-[var(--color-muted)]">no notes yet</p>
    </Disclosure>
  )
}
