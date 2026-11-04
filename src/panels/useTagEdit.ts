import { useState } from 'react'
import { API, type NodeDetail } from './useNodeDetail'

/* Edit → Review → Write, for the details panel's metadata tab.
 *
 * Tag write-back is per file (server/src/tagwrite/), and an album or an
 * artist is many files. The server works out which (#464): a track's own
 * files, every file on an album, or every file that credits an artist,
 * where a rename changes only that artist's part of a line like "A; B".
 * Review is its mandatory dry run, POST /tag-writes with the node: one tag
 * write per file that differs, the files it had to leave out and why, and
 * the node a rename merges into, if one already has the name. Nothing is
 * written until Write approves them; Discard deletes them unwritten. Each
 * one is listed under Library health → Tag writes either way, where a
 * written one can be reverted. */

export type EditableKey =
  'title' | 'artist' | 'album' | 'albumArtist' | 'releaseDate' | 'trackNo' | 'discNo' | 'genre' | 'bpm' | 'label' | 'releaseType' | 'name'
export type Draft = Partial<Record<EditableKey, string>>
export type PendingEdits = Partial<Record<EditableKey, { old: string; new: string }>>
export type SkippedFile = { fileId: number; path: string; reason: string }
export type Review = {
  editId: number
  fields: { field: string; old: string; new: string }[]
  fileCount: number
  formats: string[]
  skipped: SkippedFile[]
  merge: { id: number; title: string } | null
}
export type EditPhase = 'view' | 'edit' | 'review'

/** What each kind of node edits, in the order the form shows them. The
 *  server checks the same list (server/src/tagwrite/nodeEdit.ts). A year or
 *  a whole date both go in release date. */
export const EDITABLE: Record<string, EditableKey[]> = {
  recording: ['title', 'artist', 'album', 'albumArtist', 'releaseDate', 'trackNo', 'discNo', 'genre', 'bpm', 'label', 'releaseType'],
  release: ['album', 'albumArtist', 'releaseDate', 'genre', 'label', 'releaseType'],
  artist: ['name'],
}

export const LABELS: Record<EditableKey, string> = {
  title: 'title',
  artist: 'artist',
  album: 'album',
  albumArtist: 'album artist',
  releaseDate: 'release date',
  trackNo: 'track',
  discNo: 'disc',
  genre: 'genre',
  bpm: 'bpm',
  label: 'label',
  releaseType: 'release type',
  name: 'name',
}

/** A field's label on this kind of node: an album's own title is its
 *  "album" tag, but it's the title you're editing. */
export function labelFor(type: string, key: EditableKey): string {
  return type === 'release' && key === 'album' ? 'title' : LABELS[key]
}

const NUMBER_KEYS = new Set<EditableKey>(['trackNo', 'discNo', 'bpm'])
const DATE = /^\d{4}(-\d{2}(-\d{2})?)?$/

/** Why a value can't be written, in words, or null when it can. */
export function invalidReason(key: EditableKey, text: string): string | null {
  if (NUMBER_KEYS.has(key) && !/^\d{1,4}$/.test(text)) return `${LABELS[key]} has to be a whole number`
  if (NUMBER_KEYS.has(key) && Number(text) < 1) return `${LABELS[key]} has to be 1 or more`
  if (key === 'releaseDate' && !DATE.test(text)) return 'release date has to be a year, or a date written YYYY-MM-DD'
  if (key === 'genre' && splitGenres(text).length === 0) return 'genre needs at least one name'
  return null
}

// Several genres are written as several values, typed "Rock; Pop".
function splitGenres(text: string): string[] {
  return text
    .split(';')
    .map((g) => g.trim())
    .filter((g) => g !== '')
}

function asValue(key: EditableKey, text: string): string | number | string[] {
  if (NUMBER_KEYS.has(key)) return Number(text)
  if (key === 'genre') return splitGenres(text)
  return text
}

type DryRun = {
  noop: boolean
  editId: number | null
  fileCount: number
  formats: string[]
  skipped: SkippedFile[]
  merge: { id: number; title: string } | null
}
type Approved = { written: number; failed: { fileId: number; path: string; error: string }[]; nodeId: number | null }

async function errorOf(r: Response): Promise<string> {
  const body = (await r.json().catch(() => null)) as { error?: string } | null
  return body?.error ?? `The server answered ${r.status}.`
}

function fileName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
}

/** One line naming the files that couldn't be written, for the edit's
 *  problem line. */
function failedLine(failed: Approved['failed']): string {
  const names = failed.slice(0, 3).map((f) => fileName(f.path))
  const more = failed.length > 3 ? ` and ${failed.length - 3} more` : ''
  return `${failed.length === 1 ? "1 file wasn't" : `${failed.length} files weren't`} written: ${names.join(', ')}${more}. ${failed[0]!.error}`
}

/** `values` is what the form starts from (GET /tag-writes/node/:id), null
 *  until it has loaded. `onMoved` opens the node a merge left the edit on. */
export function useTagEdit(node: NodeDetail, values: Draft | null, onWritten: () => void, onMoved?: (nodeId: number) => void) {
  const [phase, setPhase] = useState<EditPhase>('view')
  const [initial, setInitial] = useState<Draft>({})
  const [draft, setDraft] = useState<Draft>({})
  const [review, setReview] = useState<Review | null>(null)
  const [skipped, setSkipped] = useState<SkippedFile[]>([])
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const keys = EDITABLE[node.type] ?? []

  const start = () => {
    if (!values) return
    const startFrom: Draft = {}
    for (const key of keys) startFrom[key] = values[key] ?? ''
    setProblem(null)
    setSkipped([])
    setInitial(startFrom)
    setDraft(startFrom)
    setPhase('edit')
  }

  const pending: PendingEdits = {}
  for (const key of keys) {
    const next = (draft[key] ?? '').trim()
    if (next !== (initial[key] ?? '') && next !== '') pending[key] = { old: initial[key] ?? '', new: next }
  }
  const changeCount = Object.keys(pending).length
  const invalid = (Object.entries(pending) as [EditableKey, { new: string }][])
    .map(([key, edit]) => invalidReason(key, edit.new))
    .find((reason) => reason != null)

  // The dry run. Files whose tags already match come back as no-ops and
  // aren't counted.
  const submit = async () => {
    if (changeCount === 0 || busy) return
    if (invalid) {
      setProblem(`${invalid[0]!.toUpperCase()}${invalid.slice(1)}.`)
      return
    }
    setBusy(true)
    setProblem(null)
    const changes = Object.fromEntries(Object.entries(pending).map(([key, edit]) => [key, asValue(key as EditableKey, edit.new)]))
    try {
      const r = await fetch(`${API}/tag-writes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeId: node.id, changes }),
      })
      if (!r.ok) {
        setProblem(await errorOf(r))
        return
      }
      const dry = (await r.json()) as DryRun
      setSkipped(dry.skipped)
      if (dry.noop || dry.editId == null) {
        setProblem(
          dry.skipped.length > 0
            ? "Nothing to write. These files can't take tag writes, and any others already say this."
            : 'The files already say this; nothing to write.',
        )
        return
      }
      setReview({
        editId: dry.editId,
        fields: (Object.entries(pending) as [EditableKey, { old: string; new: string }][]).map(([field, edit]) => ({
          field: labelFor(node.type, field),
          old: edit.old,
          new: edit.new,
        })),
        fileCount: dry.fileCount,
        formats: dry.formats,
        skipped: dry.skipped,
        merge: dry.merge,
      })
      setPhase('review')
    } catch {
      setProblem("Couldn't reach the server, so nothing was written.")
    } finally {
      setBusy(false)
    }
  }

  const write = async () => {
    if (!review || busy) return
    setBusy(true)
    setProblem(null)
    try {
      const r = await fetch(`${API}/tag-writes/edits/${review.editId}/approve`, { method: 'POST' })
      if (!r.ok) {
        setProblem(await errorOf(r))
        return
      }
      const approved = (await r.json()) as Approved
      setReview(null)
      setSkipped([])
      setPhase('view')
      if (approved.failed.length > 0) setProblem(failedLine(approved.failed))
      if (approved.nodeId != null && approved.nodeId !== node.id && onMoved) onMoved(approved.nodeId)
      else onWritten()
    } catch {
      setProblem("Couldn't reach the server. Library health → Tag writes shows what was written.")
    } finally {
      setBusy(false)
    }
  }

  const discard = async () => {
    if (review) await fetch(`${API}/tag-writes/edits/${review.editId}`, { method: 'DELETE' }).catch(() => undefined)
    setReview(null)
    setSkipped([])
    setPhase('view')
    setProblem(null)
  }

  return {
    phase,
    keys,
    draft,
    pending,
    changeCount,
    review,
    skipped,
    busy,
    problem,
    start,
    cancel: () => {
      setPhase('view')
      setProblem(null)
      setSkipped([])
    },
    update: (key: EditableKey, value: string) => setDraft((d) => ({ ...d, [key]: value })),
    submit: () => void submit(),
    write: () => void write(),
    discard: () => void discard(),
  }
}
