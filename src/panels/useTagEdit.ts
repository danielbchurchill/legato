import { useState } from 'react'
import { API, type NodeDetail } from './useNodeDetail'

/* Edit → Review → Write, for the details panel's metadata tab.
 *
 * Tag write-back is per file (server/src/tagwrite/), and a record is many
 * files: changing an album's label means changing it on every track. So
 * the target is every file under the node — a track's own files, or each
 * track's files for a record — and Review is the server's mandatory
 * dry-run, one tag write per file, merged by field for display. Nothing is
 * written until Write approves them all; Discard deletes them unwritten.
 * Each one is listed under Library health → Tag writes either way, where a
 * written one can be reverted. */

export type EditableKey = 'releaseDate' | 'releaseType' | 'label' | 'bpm'
export type Draft = Partial<Record<EditableKey, string>>
export type PendingEdits = Partial<Record<EditableKey, { old: string; new: string }>>
export type Review = { writeIds: number[]; fields: { field: string; old: string; new: string }[]; fileCount: number; format: string | null }
export type EditPhase = 'view' | 'edit' | 'review'

type FileFacts = {
  id: number
  bpm: number | null
  label: string | null
  release_type: string | null
  release_date: string | null
  format: string | null
}

const FILE_FIELD: Record<EditableKey, keyof FileFacts> = {
  releaseDate: 'release_date',
  releaseType: 'release_type',
  label: 'label',
  bpm: 'bpm',
}

async function filesUnder(node: NodeDetail): Promise<FileFacts[]> {
  if (node.type === 'recording') return node.files
  if (node.type !== 'release') return []
  const tracks = (await fetch(`${API}/nodes/${node.id}/tracklist`).then((r) => r.json())) as { id: number }[]
  const details = await Promise.all(tracks.map((t) => fetch(`${API}/nodes/${t.id}`).then((r) => r.json() as Promise<NodeDetail>)))
  return details.flatMap((d) => d.files)
}

function asValue(key: EditableKey, text: string): string | number {
  return key === 'bpm' ? Math.round(Number(text)) : text
}

export function useTagEdit(node: NodeDetail, onWritten: () => void) {
  const [phase, setPhase] = useState<EditPhase>('view')
  const [files, setFiles] = useState<FileFacts[]>([])
  const [initial, setInitial] = useState<Draft>({})
  const [draft, setDraft] = useState<Draft>({})
  const [review, setReview] = useState<Review | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const start = async () => {
    setProblem(null)
    setBusy(true)
    try {
      const found = await filesUnder(node)
      if (found.length === 0) {
        setProblem('There are no files under this to write tags to.')
        return
      }
      const first = found[0]
      const values: Draft = {}
      for (const key of Object.keys(FILE_FIELD) as EditableKey[]) {
        const v = first[FILE_FIELD[key]]
        values[key] = v == null ? '' : String(v)
      }
      setFiles(found)
      setInitial(values)
      setDraft(values)
      setPhase('edit')
    } finally {
      setBusy(false)
    }
  }

  const pending: PendingEdits = {}
  for (const key of Object.keys(draft) as EditableKey[]) {
    const next = (draft[key] ?? '').trim()
    if (next !== (initial[key] ?? '') && next !== '') pending[key] = { old: initial[key] ?? '', new: next }
  }
  const changeCount = Object.keys(pending).length

  // The dry run: one tag write per file with only the changed fields. A
  // file whose tags already match comes back as a no-op and isn't counted.
  const submit = async () => {
    if (changeCount === 0) return
    setBusy(true)
    setProblem(null)
    const changes = Object.fromEntries(Object.entries(pending).map(([key, edit]) => [key, asValue(key as EditableKey, edit.new)]))
    try {
      const results = await Promise.all(
        files.map((file) =>
          fetch(`${API}/tag-writes`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fileId: file.id, changes }),
          }).then(async (r) => (r.ok ? ((await r.json()) as { id?: number; noop?: true }) : null)),
        ),
      )
      const writeIds = results.filter((r): r is { id: number } => r != null && r.id != null).map((r) => r.id)
      const failed = results.filter((r) => r == null).length
      if (writeIds.length === 0) {
        setProblem(
          failed > 0
            ? "These files can't take tag writes. Write-back supports FLAC only for now."
            : 'The files already say this; nothing to write.',
        )
        return
      }
      if (failed > 0) setProblem(`${failed} of the files can't take tag writes (FLAC only for now) and were left out.`)
      setReview({
        writeIds,
        fields: Object.entries(pending).map(([field, edit]) => ({ field: LABELS[field as EditableKey], old: edit.old, new: edit.new })),
        fileCount: writeIds.length,
        format: files[0]?.format?.toUpperCase() ?? null,
      })
      setPhase('review')
    } finally {
      setBusy(false)
    }
  }

  const write = async () => {
    if (!review) return
    setBusy(true)
    try {
      for (const id of review.writeIds) await fetch(`${API}/tag-writes/${id}/approve`, { method: 'POST' })
      setReview(null)
      setPhase('view')
      onWritten()
    } finally {
      setBusy(false)
    }
  }

  const discard = async () => {
    if (review) await Promise.all(review.writeIds.map((id) => fetch(`${API}/tag-writes/${id}`, { method: 'DELETE' })))
    setReview(null)
    setPhase('view')
    setProblem(null)
  }

  return {
    phase,
    draft,
    pending,
    changeCount,
    review,
    busy,
    problem,
    start: () => void start(),
    cancel: () => {
      setPhase('view')
      setProblem(null)
    },
    update: (key: EditableKey, value: string) => setDraft((d) => ({ ...d, [key]: value })),
    submit: () => void submit(),
    write: () => void write(),
    discard: () => void discard(),
  }
}

export const LABELS: Record<EditableKey, string> = {
  releaseDate: 'release date',
  releaseType: 'release type',
  label: 'label',
  bpm: 'bpm',
}
