import { useEffect, useState } from 'react'
import { Icon } from '../ui/Icon'
import { CoverArt } from '../ui/CoverArt'
import { DataRow, SectionHeader } from '../ui/DataRow'
import type { PlaybackStatus, QueueEntry } from '../playback/usePlayback'

const API = 'http://127.0.0.1:8899/api/v1'

/* The right-hand panel's now-playing mode.
 *
 * Editable fields are exactly the ones the tag write-back API actually
 * supports (server/src/tagwrite/fields.ts): bpm, label, release type.
 * release_date is shown too — it lives in the file tags same as the other
 * three — but stays read-only, since TagLib# has no writable "release
 * date" property distinct from the numeric year and adding one wasn't in
 * scope here. Title/artist/album are display only in this pass; editing
 * those touches match/collapse identity, a different question from
 * fixing a wrong bpm.
 *
 * Pagination — lyrics and article pages, the three dots — is session 7. */

function formatDuration(ms: number | null): string {
  if (ms == null) return '—'
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

type Edge = { direction: 'in' | 'out'; type: string; other_id: number; other_title: string }
type FileRow = {
  id: number
  bpm: number | null
  label: string | null
  release_date: string | null
  release_type: string | null
}
type NodeDetail = {
  id: number
  title: string
  recording: { canonical_duration_ms: number | null } | null
  files: FileRow[]
  edges: Edge[]
}
type FieldDiff = { field: string; oldValue: string | number; newValue: string | number }
type TagWriteRow = { id: number; status: string; diff_json: string }

type EditableFields = { bpm?: number; label?: string; releaseType?: string }

type NowPlayingPanelProps = {
  nodeId: number | null
  status: PlaybackStatus
  upNext: QueueEntry[]
  onSelectNode: (id: number) => void
}

export function NowPlayingPanel({ nodeId, status, upNext, onSelectNode }: NowPlayingPanelProps) {
  const [node, setNode] = useState<NodeDetail | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<EditableFields>({})
  const [pendingWrite, setPendingWrite] = useState<{ id: number; diff: FieldDiff[] } | null>(null)
  const [upNextOpen, setUpNextOpen] = useState(false)

  const loadNode = (id: number) => {
    fetch(`${API}/nodes/${id}`)
      .then((r) => r.json())
      .then(setNode)
      .catch(() => setNode(null))
  }

  useEffect(() => {
    setEditing(false)
    setPendingWrite(null)
    if (nodeId == null) {
      setNode(null)
      return
    }
    loadNode(nodeId)
  }, [nodeId])

  if (nodeId == null || !node) {
    return (
      <p className="pt-[40px] text-center text-[length:var(--text-base)] text-[var(--color-muted)]">
        nothing playing
      </p>
    )
  }

  const file = node.files[0] as FileRow | undefined
  const artist = node.edges.find((e) => e.direction === 'out' && e.type === 'performed_by')
  const album = node.edges.find((e) => e.direction === 'out' && e.type === 'appears_on')

  const startEditing = () => {
    setDraft({
      bpm: file?.bpm ?? undefined,
      label: file?.label ?? undefined,
      releaseType: file?.release_type ?? undefined,
    })
    setEditing(true)
  }

  // Mandatory dry-run diff, per Legato.md's write-back spec — this only
  // ever computes and stores a diff for review, never writes to disk.
  const submitDraft = async () => {
    if (!file) return
    const res = await fetch(`${API}/tag-writes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId: file.id, changes: draft }),
    })
    const data = (await res.json()) as (TagWriteRow & { diff_json: string }) | { noop: true }
    setEditing(false)
    if ('noop' in data) return // on-disk already matches — nothing to review
    setPendingWrite({ id: data.id, diff: JSON.parse(data.diff_json) as FieldDiff[] })
  }

  const approveWrite = async () => {
    if (!pendingWrite) return
    await fetch(`${API}/tag-writes/${pendingWrite.id}/approve`, { method: 'POST' })
    setPendingWrite(null)
    loadNode(node.id)
  }

  return (
    <div className="flex flex-col">
      <CoverArt
        nodeId={node.id}
        size="full"
        alt={`Cover art for ${node.title}`}
        className="aspect-square w-full"
      />

      <div className="mt-[12px] flex items-start justify-between gap-[8px]">
        <div className="min-w-0">
          <p className="truncate font-[family-name:var(--font-mono)] text-[length:var(--text-base)] text-[var(--color-ink)]">
            {node.title}
          </p>
          {(artist || album) && (
            <p className="truncate text-[length:var(--text-base)] text-[var(--color-muted)]">
              {artist?.other_title}
              {artist && album ? ' — ' : ''}
              {album?.other_title}
            </p>
          )}
        </div>
        {upNext.length > 0 && (
          <button
            type="button"
            onClick={() => setUpNextOpen((v) => !v)}
            aria-label={upNextOpen ? 'Hide up next' : 'Show up next'}
            aria-expanded={upNextOpen}
            className={`shrink-0 text-[var(--color-muted)] transition-transform duration-150 hover:text-[var(--color-ink)] ${
              upNextOpen ? 'rotate-180' : ''
            }`}
          >
            <Icon name="chevron-down" size={24} />
          </button>
        )}
      </div>

      {upNextOpen && upNext.length > 0 && (
        <>
          <SectionHeader title="up next" />
          <ul className="mt-[8px] flex flex-col">
            {upNext.map((entry) => (
              <li key={entry.recordingNodeId}>
                <button
                  type="button"
                  onClick={() => onSelectNode(entry.recordingNodeId)}
                  className="w-full truncate py-[4px] text-left font-[family-name:var(--font-mono)] text-[length:var(--text-base)] text-[var(--color-muted)] transition-colors duration-150 hover:text-[var(--color-ink)]"
                >
                  {entry.title}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <SectionHeader
        title="metadata"
        action={
          !editing &&
          !pendingWrite && (
            <button
              type="button"
              onClick={startEditing}
              aria-label="Edit metadata"
              title="Edit metadata"
              className="text-[var(--color-muted)] transition-colors duration-150 hover:text-[var(--color-ink)]"
            >
              <Icon name="pencil" size={24} />
            </button>
          )
        }
      />

      <div className="mt-[8px]">
        <DataRow label="length" value={formatDuration(node.recording?.canonical_duration_ms ?? null)} />
        <DataRow label="elapsed" value={formatDuration(status.positionMs)} />
        {editing ? (
          <>
            <DataRow
              label="bpm"
              value={
                <input
                  type="number"
                  value={draft.bpm ?? ''}
                  onChange={(e) => setDraft((d) => ({ ...d, bpm: e.target.value ? Number(e.target.value) : undefined }))}
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
                  onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
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
                  onChange={(e) => setDraft((d) => ({ ...d, releaseType: e.target.value }))}
                  className="w-full bg-transparent font-[family-name:var(--font-mono)] text-[length:var(--text-base)] text-[var(--color-ink)] outline-none"
                />
              }
            />
            <div className="flex gap-[16px] pt-[10px]">
              <button
                type="button"
                onClick={submitDraft}
                className="text-[length:var(--text-base)] text-[var(--color-ink)] underline decoration-[var(--color-hairline)] underline-offset-2 hover:text-[var(--color-muted)]"
              >
                review changes
              </button>
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="text-[length:var(--text-base)] text-[var(--color-muted)] hover:text-[var(--color-ink)]"
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

      {pendingWrite && (
        <>
          <SectionHeader title="review diff" />
          <ul className="mt-[8px] flex flex-col gap-[2px]">
            {pendingWrite.diff.map((d) => (
              <li
                key={d.field}
                className="font-[family-name:var(--font-mono)] text-[length:var(--text-base)] text-[var(--color-muted)]"
              >
                {d.field}: {String(d.oldValue)} → <span className="text-[var(--color-ink)]">{String(d.newValue)}</span>
              </li>
            ))}
          </ul>
          <div className="flex gap-[16px] pt-[10px]">
            <button
              type="button"
              onClick={approveWrite}
              className="text-[length:var(--text-base)] text-[var(--color-ink)] underline decoration-[var(--color-hairline)] underline-offset-2 hover:text-[var(--color-muted)]"
            >
              approve — write to file
            </button>
            {/* Not a delete — no DELETE /tag-writes/:id exists. This just
             * closes the inline review; the pending_review row is still
             * real and still shows up in the maintenance view's tag-write
             * section if it's never approved. */}
            <button
              type="button"
              onClick={() => setPendingWrite(null)}
              className="text-[length:var(--text-base)] text-[var(--color-muted)] hover:text-[var(--color-ink)]"
            >
              close
            </button>
          </div>
        </>
      )}
    </div>
  )
}
