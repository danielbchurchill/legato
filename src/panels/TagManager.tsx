import { useEffect, useState } from 'react'
import { SERVER_HOST } from '../config/serverHost'

const API = `http://${SERVER_HOST}:8899/api/v1`

/* Tag Manager rail destination (v1): proactive, library-wide browsing of
 * "which tracks are missing X" — deliberately not an editor. A row click
 * selects+flies to the node (same pattern as every other list in the app —
 * search, similarity, the hygiene worklist) so the real edit flow already
 * on that node's own detail view (MetadataFields.tsx/useMetadataEditing.ts)
 * handles the write. See Legato-Stage-Four-Rail-Gaps.md "3. Tag Manager". */

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

export function TagManager({ onSelectNode }: { onSelectNode: (id: number) => void }) {
  const [field, setField] = useState<Field>('bpm')
  const [rows, setRows] = useState<Row[] | null>(null)

  useEffect(() => {
    setRows(null)
    fetch(`${API}/tag-manager?field=${field}`)
      .then((r) => r.json())
      .then(setRows)
      .catch(() => setRows([]))
  }, [field])

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
                  className="min-w-0 flex-1 truncate text-left font-[family-name:var(--font-mono)] text-[length:var(--text-base)] text-[var(--color-ink)] transition-colors duration-150 hover:text-[var(--color-muted-hi)]"
                >
                  {row.title}
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
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
