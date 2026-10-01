import { useEffect, useState } from 'react'
import { API, type EditableFields, type FieldDiff, type FileRow, type NodeDetail, type TagWriteRow } from './useNodeDetail'

export type MetadataEditingState = {
  editing: boolean
  draft: EditableFields
  pendingWrite: { id: number; diff: FieldDiff[] } | null
  updateDraft: (patch: Partial<EditableFields>) => void
  startEditing: () => void
  cancelEditing: () => void
  submitDraft: () => Promise<void>
  approveWrite: () => Promise<void>
  discardWrite: () => Promise<void>
}

/* The edit -> mandatory dry-run diff -> approve/discard flow for tag
 * write-back (the one operation that can destroy user data), lifted out of the metadata page so both the paginated
 * inspector and the persistent panel's track-metadata disclosure drive one
 * state machine instead of two copies that could drift apart. Editable
 * fields are exactly what the tag write-back API supports
 * (server/src/tagwrite/fields.ts): bpm, label, release type, release date.
 * Editing is file-scoped, so it only ever applies to recording nodes. */
export function useMetadataEditing(node: NodeDetail, reload: () => void): MetadataEditingState {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<EditableFields>({})
  const [pendingWrite, setPendingWrite] = useState<{ id: number; diff: FieldDiff[] } | null>(null)

  // Reset per-node view state whenever the node changes — an edit or a
  // pending diff left open on the last track must not carry over onto a
  // different one.
  useEffect(() => {
    setEditing(false)
    setPendingWrite(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id])

  const startEditing = () => {
    const file = node.files[0] as FileRow | undefined
    setDraft({
      bpm: file?.bpm ?? undefined,
      label: file?.label ?? undefined,
      releaseType: file?.release_type ?? undefined,
      releaseDate: file?.release_date ?? undefined,
    })
    setEditing(true)
  }

  // Mandatory dry-run diff before any tag write — this only
  // ever computes and stores a diff for review, never writes to disk.
  const submitDraft = async () => {
    const file = node.files[0] as FileRow | undefined
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
    reload()
  }

  const discardWrite = async () => {
    if (!pendingWrite) return
    await fetch(`${API}/tag-writes/${pendingWrite.id}`, { method: 'DELETE' })
    setPendingWrite(null)
  }

  return {
    editing,
    draft,
    pendingWrite,
    updateDraft: (patch) => setDraft((d) => ({ ...d, ...patch })),
    startEditing,
    cancelEditing: () => setEditing(false),
    submitDraft,
    approveWrite,
    discardWrite,
  }
}
