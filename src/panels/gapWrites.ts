import { API_BASE as API } from '../config/serverHost'
import { formatDiffValue, type FieldDiff, type GapField } from './healthData'

/* Filling metadata gaps through tag writes (#469). A value never goes
 * straight into a file: each file gets its own POST /tag-writes, the dry
 * run every tag edit in Legato makes, and nothing is written until those
 * are approved. An album's value is proposed for each of its files that's
 * missing it, then reviewed and written, or discarded, together. */

type TagKey = 'label' | 'releaseDate' | 'releaseType' | 'bpm'
export type TagChanges = Partial<Record<TagKey, string | number>>

/* The tag-write field each gap is filled through, how its text becomes a
 * value, and what to type. "Unmatched" has no field: matching is the
 * remedy, not a value. */
export const GAP_WRITE: Partial<Record<GapField, { key: TagKey; parse: (v: string) => string | number | null; hint: string }>> = {
  label: { key: 'label', parse: (v) => v || null, hint: 'Columbia' },
  release_date: { key: 'releaseDate', parse: (v) => (/^\d{4}(-\d{2}(-\d{2})?)?$/.test(v) ? v : null), hint: 'YYYY-MM-DD' },
  release_type: { key: 'releaseType', parse: (v) => v.toLowerCase() || null, hint: 'album' },
  bpm: { key: 'bpm', parse: (v) => (/^\d+(\.\d+)?$/.test(v) ? Math.round(Number(v)) : null), hint: '120' },
}

/** The values typed in, parsed; the fields left empty are left out. Throws
 * the field whose text isn't a value of its kind. */
export function parseValues(text: Partial<Record<GapField, string>>): Partial<Record<GapField, string | number>> {
  const values: Partial<Record<GapField, string | number>> = {}
  for (const [field, raw] of Object.entries(text) as [GapField, string][]) {
    const write = GAP_WRITE[field]
    const trimmed = raw.trim()
    if (!write || trimmed === '') continue
    const value = write.parse(trimmed)
    if (value == null) throw new InvalidValue(field)
    values[field] = value
  }
  return values
}

export class InvalidValue extends Error {
  readonly field: GapField
  constructor(field: GapField) {
    super(`not a ${field}`)
    this.field = field
  }
}

/** What to write to a file: each value for a field it's missing. Null when
 * there's nothing, so a file that has them all is left alone. */
export function changesFor(missing: GapField[], values: Partial<Record<GapField, string | number>>): TagChanges | null {
  const changes: TagChanges = {}
  for (const field of missing) {
    const write = GAP_WRITE[field]
    const value = values[field]
    if (write && value != null) changes[write.key] = value
  }
  return Object.keys(changes).length > 0 ? changes : null
}

export type Proposed = { id: number; fileId: number; diff: FieldDiff[] }
export type Proposal = {
  proposed: Proposed[]
  /** Files whose tags already had the value, which the server makes no write for. */
  unchanged: number
  failed: { fileId: number; error: string }[]
}

/** One dry run per file, one after another. */
export async function proposeWrites(targets: { fileId: number; changes: TagChanges }[]): Promise<Proposal> {
  const result: Proposal = { proposed: [], unchanged: 0, failed: [] }
  for (const { fileId, changes } of targets) {
    try {
      const res = await fetch(`${API}/tag-writes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId, changes }),
      })
      const body = (await res.json().catch(() => null)) as { id?: number; diff_json?: string; noop?: boolean; error?: string } | null
      if (!res.ok || body == null) {
        result.failed.push({ fileId, error: body?.error ?? "The server couldn't prepare this change." })
      } else if (body.noop) {
        result.unchanged += 1
      } else if (body.id != null) {
        result.proposed.push({ id: body.id, fileId, diff: parseDiffJson(body.diff_json) })
      }
    } catch {
      result.failed.push({ fileId, error: "Couldn't reach the Legato server." })
    }
  }
  return result
}

function parseDiffJson(json: string | undefined): FieldDiff[] {
  try {
    return JSON.parse(json ?? '[]') as FieldDiff[]
  } catch {
    return []
  }
}

/** Each change once, with how many files it's going to: "label › Columbia
 * on 11 files". */
export function summarize(proposed: Proposed[]): { field: string; value: string; files: number }[] {
  const lines = new Map<string, { field: string; value: string; files: number }>()
  for (const { diff } of proposed) {
    for (const d of diff) {
      const value = formatDiffValue(d.newValue)
      const key = `${d.field}\u0000${value}`
      const line = lines.get(key) ?? { field: d.field, value, files: 0 }
      line.files += 1
      lines.set(key, line)
    }
  }
  return [...lines.values()]
}

/** Writes the proposed changes, one file at a time, saying how far it's got. */
export async function approveWrites(
  ids: number[],
  onProgress: (done: number) => void = () => undefined,
): Promise<{ written: number; failed: { id: number; error: string }[] }> {
  let written = 0
  const failed: { id: number; error: string }[] = []
  for (const [i, id] of ids.entries()) {
    try {
      const res = await fetch(`${API}/tag-writes/${id}/approve`, { method: 'POST' })
      if (res.ok) written += 1
      else {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        failed.push({ id, error: body?.error ?? "Couldn't write this file." })
      }
    } catch {
      failed.push({ id, error: "Couldn't reach the Legato server." })
    }
    onProgress(i + 1)
  }
  return { written, failed }
}

/** Drops proposed changes without writing anything. */
export async function discardWrites(ids: number[]): Promise<void> {
  for (const id of ids) {
    await fetch(`${API}/tag-writes/${id}`, { method: 'DELETE' }).catch(() => undefined)
  }
}
