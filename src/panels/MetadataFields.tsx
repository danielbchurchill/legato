import type { ReactNode } from 'react'
import { Icon } from '../ui/Icon'
import { DataRow, SectionHeader } from '../ui/DataRow'
import { Button } from '../ui/Button'
import { Tooltip } from '../ui/Tooltip'
import { formatDuration } from '../ui/format'
import type { FileRow, NodeDetail } from './useNodeDetail'
import type { MetadataEditingState } from './useMetadataEditing'

/* The track-metadata content shared between NodeDetailPages' pager page and
 * NowPlayingSections' track-metadata disclosure: the play/edit header
 * actions, the DataRows (read-only or mid-edit), the pending-write diff
 * review, the mbid, and the file-instance list. Split into small pieces
 * rather than one component because the two hosts interleave this content
 * differently with connections content (see ConnectionsContent.tsx) — the
 * pager sandwiches mbid/instances between "recordings" and "personal
 * edges" to match today's exact layout, while the panel groups all of this
 * together in one disclosure. */

export function MetadataActions({
  node,
  file,
  isPlaying,
  onPlay,
  onEdit,
}: {
  node: NodeDetail
  file: FileRow | undefined
  isPlaying: boolean
  onPlay: (nodeId: number, title: string) => void
  onEdit: () => void
}) {
  return (
    <div className="flex items-center gap-[16px]">
      {node.recording && !isPlaying && (
        <Tooltip label="Play">
          <button
            type="button"
            onClick={() => onPlay(node.id, node.title)}
            aria-label="Play"
            className="text-[var(--color-muted)] transition-colors duration-150 hover:text-[var(--color-muted-hi)]"
          >
            <Icon name="play" size={24} />
          </button>
        </Tooltip>
      )}
      {file && (
        <Tooltip label="Edit metadata">
          <button
            type="button"
            onClick={onEdit}
            aria-label="Edit metadata"
            className="text-[var(--color-muted)] transition-colors duration-150 hover:text-[var(--color-muted-hi)]"
          >
            <Icon name="pencil" size={24} />
          </button>
        </Tooltip>
      )}
    </div>
  )
}

/** `extraRows` renders before track no./length, inside the same wrapper —
 * the panel uses it for a `plays` row the pager never had. */
export function MetadataRows({
  node,
  editingState,
  extraRows,
}: {
  node: NodeDetail
  editingState: MetadataEditingState
  extraRows?: ReactNode
}) {
  if (!node.recording) return null
  const file = node.files[0] as FileRow | undefined
  const { editing, draft, updateDraft, submitDraft, cancelEditing } = editingState

  return (
    <div className="mt-[8px]">
      {extraRows}
      <DataRow label="track no." value={file?.track_no ?? '—'} />
      <DataRow label="length" value={formatDuration(node.recording.canonical_duration_ms)} />
      {editing ? (
        <>
          <DataRow
            label="bpm"
            value={
              <input
                type="number"
                value={draft.bpm ?? ''}
                onChange={(e) => updateDraft({ bpm: e.target.value ? Number(e.target.value) : undefined })}
                className="w-full bg-transparent font-[family-name:var(--font-mono)] text-[length:var(--text-base)] text-[var(--color-ink)] outline-none"
              />
            }
          />
          <DataRow
            label="label"
            value={
              <input
                type="text"
                value={draft.label ?? ''}
                onChange={(e) => updateDraft({ label: e.target.value })}
                className="w-full bg-transparent font-[family-name:var(--font-mono)] text-[length:var(--text-base)] text-[var(--color-ink)] outline-none"
              />
            }
          />
          <DataRow
            label="release date"
            value={
              <input
                type="text"
                value={draft.releaseDate ?? ''}
                onChange={(e) => updateDraft({ releaseDate: e.target.value })}
                className="w-full bg-transparent font-[family-name:var(--font-mono)] text-[length:var(--text-base)] text-[var(--color-ink)] outline-none"
              />
            }
          />
          <DataRow
            label="release type"
            value={
              <input
                type="text"
                value={draft.releaseType ?? ''}
                onChange={(e) => updateDraft({ releaseType: e.target.value })}
                className="w-full bg-transparent font-[family-name:var(--font-mono)] text-[length:var(--text-base)] text-[var(--color-ink)] outline-none"
              />
            }
          />
          <div className="flex gap-[16px] pt-[10px]">
            <Button onClick={submitDraft}>review changes</Button>
            <button
              type="button"
              onClick={cancelEditing}
              className="text-[length:var(--text-base)] text-[var(--color-muted)] hover:text-[var(--color-muted-hi)]"
            >
              cancel
            </button>
          </div>
        </>
      ) : (
        <>
          {file?.bpm != null && <DataRow label="bpm" value={file.bpm} />}
          {file?.label && <DataRow label="label" value={file.label} />}
          {file?.release_date && <DataRow label="release date" value={file.release_date} />}
          {file?.release_type && <DataRow label="release type" value={file.release_type} />}
        </>
      )}
    </div>
  )
}

export function PendingWriteReview({ editingState }: { editingState: MetadataEditingState }) {
  const { pendingWrite, approveWrite, discardWrite } = editingState
  if (!pendingWrite) return null
  return (
    <>
      <SectionHeader title="review diff" />
      <ul className="mt-[8px] flex flex-col gap-[2px]">
        {pendingWrite.diff.map((d) => (
          <li key={d.field} className="font-[family-name:var(--font-mono)] text-[length:var(--text-base)] text-[var(--color-muted)]">
            {d.field}: {String(d.oldValue)} → <span className="text-[var(--color-ink)]">{String(d.newValue)}</span>
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-[16px] pt-[10px]">
        <Button variant="destructive" onClick={approveWrite}>
          approve — write to file
        </Button>
        <button
          type="button"
          onClick={discardWrite}
          className="text-[length:var(--text-base)] text-[var(--color-muted)] hover:text-[var(--color-muted-hi)]"
        >
          discard
        </button>
      </div>
    </>
  )
}

export function MbidBlock({ node }: { node: NodeDetail }) {
  if (!node.mbid) return null
  return (
    <div className="pt-[15px]">
      <p className="text-[length:var(--text-base)] text-[var(--color-muted)]">mbid</p>
      <p className="mt-[4px] break-all font-[family-name:var(--font-mono)] text-[length:var(--text-base)] text-[var(--color-ink)]">
        {node.mbid}
      </p>
    </div>
  )
}

export function InstancesList({ node }: { node: NodeDetail }) {
  if (node.files.length <= 1) return null
  return (
    <>
      <SectionHeader title={`instances (${node.files.length})`} />
      <ul className="mt-[8px] flex flex-col gap-[8px]">
        {node.files.map((f) => (
          <li key={f.file_path}>
            <p className="font-[family-name:var(--font-mono)] text-[length:var(--text-base)] text-[var(--color-ink)]">
              {f.format ?? '—'} · {f.bitrate ? `${Math.round(f.bitrate / 1000)}kbps` : '—'}
            </p>
            <p className="mt-[2px] break-all font-[family-name:var(--font-mono)] text-[length:var(--text-base)] text-[var(--color-ink)]">
              {f.file_path}
            </p>
          </li>
        ))}
      </ul>
    </>
  )
}
