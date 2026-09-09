import { useCallback, useEffect, useState } from 'react'
import { ScrollingText } from '../ui/ScrollingText'
import { SERVER_HOST } from '../config/serverHost'

const API = `http://${SERVER_HOST}:8899/api/v1`

/* Tag Manager rail destination: proactive, library-wide browsing of "which
 * tracks are missing X," plus the two actions issue #65 found missing —
 * rescanning a track whose tags were fixed outside the app (POST
 * /nodes/:id/rescan, scan/scanner.ts's rescanNode) and jumping straight
 * into the existing edit -> diff -> approve flow (MetadataFields.tsx/
 * useMetadataEditing.ts) instead of only flying the canvas to the node and
 * making the user hunt for the pencil icon themselves. Still not a second
 * editor of its own — both actions delegate to the same machinery every
 * other surface in the app uses. See Legato-Stage-Four-Rail-Gaps.md "3.
 * Tag Manager" for the original v1 scope this extends. */

type Field = 'bpm' | 'label' | 'release_date' | 'release_type' | 'unmatched'
type Row = { id: number; title: string; artist: string | null }

const FIELDS: Field[] = ['bpm', 'label', 'release_date', 'release_type', 'unmatched']

const FIELD_LABEL: Record<Field, string> = {
  bpm: 'bpm',
  label: 'label',
  release_date: 'release date',
  release_type: 'release type',
  unmatched: 'unmatched',
}

const MISSING_TAG: Record<Field, string> = {
  bpm: 'missing bpm',
  label: 'missing label',
  release_date: 'missing release date',
  release_type: 'missing release type',
  unmatched: 'unmatched',
}

// DESIGN.md "No maintenance items ... should read as calm, not empty" — the
// same voice, applied per field rather than reused verbatim.
const EMPTY_MESSAGE: Record<Field, string> = {
  bpm: 'Every track has a bpm.',
  label: 'Every track has a label.',
  release_date: 'Every track has a release date.',
  release_type: 'Every track has a release type.',
  unmatched: 'Every track is matched.',
}

type RescanResult = { fileId: number; filePath: string; outcome?: string; error?: string }

export function TagManager({
  onSelectNode,
  onEditNode,
}: {
  onSelectNode: (id: number) => void
  /** Jumps straight into the pencil-edit flow on the node's own detail
   * view, rather than only selecting it. */
  onEditNode: (id: number) => void
}) {
  const [field, setField] = useState<Field>('bpm')
  const [rows, setRows] = useState<Row[] | null>(null)
  const [rescanning, setRescanning] = useState<Set<number>>(new Set())
  const [rescanErrors, setRescanErrors] = useState<Record<number, string>>({})

  const fetchRows = useCallback(() => fetch(`${API}/tag-manager?field=${field}`).then((r) => r.json()), [field])

  useEffect(() => {
    setRows(null)
    setRescanErrors({})
    fetchRows()
      .then(setRows)
      .catch(() => setRows([]))
  }, [field, fetchRows])

  // A rescan can fix the very field this list is filtered on (the file was
  // edited by an outside tool since the last scan) — refetching afterward,
  // rather than patching the row in place, is what lets a now-complete
  // track quietly drop off its own "missing" list.
  const handleRescan = async (id: number) => {
    setRescanning((prev) => new Set(prev).add(id))
    setRescanErrors(({ [id]: _discarded, ...rest }) => rest)
    try {
      const res = await fetch(`${API}/nodes/${id}/rescan`, { method: 'POST' })
      if (!res.ok) throw new Error(`server returned ${res.status}`)
      const data = (await res.json()) as { results: RescanResult[] }
      const failed = data.results.find((r) => r.error)
      if (failed) throw new Error(failed.error)
      setRows(await fetchRows())
    } catch {
      setRescanErrors((prev) => ({ ...prev, [id]: 'rescan failed' }))
    } finally {
      setRescanning((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  return (
    <div>
      <div className="flex flex-wrap gap-x-[var(--spacing-lg)] gap-y-[var(--spacing-sm)]">
        {FIELDS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setField(f)}
            className={`text-[length:var(--text-base)] transition-colors duration-150 ${
              field === f ? 'text-[var(--color-ink)]' : 'text-[var(--color-muted)] hover:text-[var(--color-muted-hi)]'
            }`}
          >
            {FIELD_LABEL[f]}
          </button>
        ))}
      </div>

      {rows === null ? (
        <p className="pt-[24px] text-[length:var(--text-base)] text-[var(--color-muted)]">loading…</p>
      ) : rows.length === 0 ? (
        <p className="pt-[24px] text-[length:var(--text-base)] text-[var(--color-muted)]">{EMPTY_MESSAGE[field]}</p>
      ) : (
        <div className="mt-[8px]">
          {rows.map((row) => (
            <div key={row.id} className="flex flex-col gap-[6px] border-b border-[var(--color-divider)] py-[15px] last:border-b-0">
              <div className="flex items-baseline justify-between gap-[12px]">
                {/* Plain hover-color-shift button, matching every other
                 * "click a title to fly to this node" affordance in the app
                 * (Favourites' own row, the maintenance preview, similarity
                 * thumbnails, search results) — none of which underline. */}
                <button
                  type="button"
                  onClick={() => onSelectNode(row.id)}
                  className="min-w-0 flex-1 text-left text-[var(--color-ink)] transition-colors duration-150 hover:text-[var(--color-muted-hi)]"
                >
                  <ScrollingText text={row.title} className="font-[family-name:var(--font-mono)] text-[length:var(--text-base)]" />
                </button>
                <span className="shrink-0 text-[length:var(--text-base)] text-[var(--color-muted)]">
                  {MISSING_TAG[field]}
                </span>
              </div>
              {row.artist && (
                <p className="font-[family-name:var(--font-mono)] text-[length:var(--text-base)] text-[var(--color-muted)]">
                  {row.artist}
                </p>
              )}
              <div className="flex items-center gap-[16px]">
                <button
                  type="button"
                  onClick={() => onEditNode(row.id)}
                  className="text-[length:var(--text-base)] text-[var(--color-muted)] transition-colors duration-150 hover:text-[var(--color-muted-hi)]"
                >
                  edit
                </button>
                <button
                  type="button"
                  onClick={() => handleRescan(row.id)}
                  disabled={rescanning.has(row.id)}
                  className="text-[length:var(--text-base)] text-[var(--color-muted)] transition-colors duration-150 hover:text-[var(--color-muted-hi)] disabled:pointer-events-none disabled:opacity-50"
                >
                  {rescanning.has(row.id) ? 'rescanning…' : 'rescan'}
                </button>
                {rescanErrors[row.id] && (
                  <span className="text-[length:var(--text-base)] text-[var(--color-muted)]">
                    {rescanErrors[row.id]}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
