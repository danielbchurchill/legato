import { useCallback, useEffect, useState } from 'react'
import { useWsEvent } from '../hooks/useWs'
import { useModalTransition } from '../hooks/useModalTransition'
import { Icon } from '../ui/Icon'
import { Surface } from '../shell/Surface'
import { SectionHeader } from '../ui/DataRow'
import { Button } from '../ui/Button'
import { SERVER_HOST } from '../config/serverHost'

const API = `http://${SERVER_HOST}:8899/api/v1`

type WorklistItem =
  | {
      type: 'fuzzy_pending'
      fileId: number
      filePath: string
      nodeId: number
      nodeTitle: string
      candidateNodeId: number
      candidateTitle: string
    }
  | { type: 'enrichment_flag'; nodeId: number; nodeTitle: string; note: string | null; updatedAt: string }
  | { type: 'missing_file'; fileId: number; filePath: string; nodeId: number; nodeTitle: string; missingSince: string }
  | { type: 'wont_decode'; fileId: number; filePath: string; nodeId: number; nodeTitle: string; error: string; updatedAt: string }

const TYPE_LABEL: Record<WorklistItem['type'], string> = {
  fuzzy_pending: 'possible duplicate',
  enrichment_flag: 'enrichment issue',
  missing_file: 'missing file',
  wont_decode: "won't decode",
}

type FieldDiff = { field: string; oldValue: string | number | string[]; newValue: string | number | string[] }
type TagWriteStatus = 'pending_review' | 'approved' | 'written' | 'failed' | 'reverted'
type TagWrite = {
  id: number
  file_id: number
  status: TagWriteStatus
  diff_json: string
  requested_at: string
  written_at: string | null
  reverted_at: string | null
  error_message: string | null
}

const TAG_WRITE_STATUS_LABEL: Record<TagWriteStatus, string> = {
  pending_review: 'pending review',
  approved: 'approved',
  written: 'written',
  failed: 'failed',
  reverted: 'reverted',
}

type MatchCandidate = {
  id: number
  mbid: string
  release_title: string | null
  release_date: string | null
  duration_ms: number | null
  score: number
  duration_delta_ms: number | null
}

function yearOf(dateStr: string | null): string | null {
  return dateStr ? (/^\d{4}/.exec(dateStr)?.[0] ?? null) : null
}

function formatDelta(ms: number | null): string {
  if (ms == null) return 'no local duration to compare'
  return `Δ ${Math.round(ms / 1000)}s`
}

// M-5: candidates used to be a wall of UUIDs in the note text with no way
// to act on any of them. Real rows now (server/src/migrations/0018), shown
// in the same 0fr -> 1fr disclosure MO-4 built for up-next — fetched only
// once actually opened, since most ambiguous items are never expanded.
// Resolving broadcasts hygiene:changed the same way every other write in
// this view does, so the parent's existing WS listener reloads the
// worklist — no separate refresh callback needed here.
function AmbiguousMatchDisclosure({ nodeId }: { nodeId: number }) {
  const [open, setOpen] = useState(false)
  const [candidates, setCandidates] = useState<MatchCandidate[] | null>(null)

  const toggle = () => {
    if (!open && candidates === null) {
      fetch(`${API}/hygiene/match-candidates/${nodeId}`)
        .then((r) => r.json())
        .then(setCandidates)
        .catch(() => setCandidates([]))
    }
    setOpen((v) => !v)
  }

  const resolve = async (mbid: string) => {
    await fetch(`${API}/hygiene/match-candidates/${nodeId}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mbid }),
    })
  }

  return (
    <div>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="text-[length:var(--text-base)] text-[var(--color-muted)] transition-colors duration-150 hover:text-[var(--color-muted-hi)]"
      >
        {open ? 'hide candidates' : 'show candidates'}
      </button>
      <div
        className={`grid transition-all duration-[var(--motion-base)] ease-[var(--ease-inout)] motion-reduce:transition-none ${
          open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
        }`}
      >
        <div className="min-h-0 overflow-hidden">
          {candidates === null ? (
            <p className="mt-[8px] text-[length:var(--text-base)] text-[var(--color-muted)]">loading…</p>
          ) : (
            <ul className="mt-[8px] flex flex-col gap-[8px]">
              {candidates.map((c) => (
                <li key={c.mbid} className="flex items-center justify-between gap-[12px]">
                  <span className="min-w-0 truncate font-[family-name:var(--font-mono)] text-[length:var(--text-base)] text-[var(--color-ink)]">
                    {c.release_title ?? 'unknown release'}
                    {yearOf(c.release_date) && <span className="text-[var(--color-muted)]"> · {yearOf(c.release_date)}</span>}
                    <span className="text-[var(--color-muted)]"> · {formatDelta(c.duration_delta_ms)}</span>
                  </span>
                  <Button onClick={() => resolve(c.mbid)}>use this</Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

function WorklistRow({
  item,
  onSelectNode,
  onResolveFuzzy,
}: {
  item: WorklistItem
  onSelectNode: (id: number) => void
  onResolveFuzzy: (fileId: number, forcedRecordingNodeId: number | null) => void
}) {
  return (
    <div className="flex flex-col gap-[6px] border-b border-[var(--color-divider)] py-[15px] last:border-b-0">
      <div className="flex items-baseline justify-between gap-[12px]">
        <Button className="font-[family-name:var(--font-mono)]" onClick={() => onSelectNode(item.nodeId)}>
          {item.nodeTitle}
        </Button>
        <span className="shrink-0 text-[length:var(--text-base)] text-[var(--color-muted)]">
          {TYPE_LABEL[item.type]}
        </span>
      </div>

      {item.type === 'fuzzy_pending' && (
        <div className="flex flex-wrap items-baseline justify-between gap-[12px]">
          <span className="text-[length:var(--text-base)] text-[var(--color-muted)]">
            looks like{' '}
            <Button
              className="font-[family-name:var(--font-mono)]"
              onClick={() => onSelectNode(item.candidateNodeId)}
            >
              {item.candidateTitle}
            </Button>
          </span>
          <div className="flex gap-[16px]">
            <Button onClick={() => onResolveFuzzy(item.fileId, item.candidateNodeId)}>merge</Button>
            <Button onClick={() => onResolveFuzzy(item.fileId, null)}>keep separate</Button>
          </div>
        </div>
      )}
      {item.type === 'enrichment_flag' && (
        <>
          <p className="font-[family-name:var(--font-mono)] text-[length:var(--text-base)] text-[var(--color-muted)]">
            {item.note}
          </p>
          {item.note?.startsWith('ambiguous') && <AmbiguousMatchDisclosure nodeId={item.nodeId} />}
        </>
      )}
      {item.type === 'missing_file' && (
        <p className="truncate text-[length:var(--text-base)] text-[var(--color-muted)]">
          <span className="font-[family-name:var(--font-mono)]">{item.filePath}</span> — missing since{' '}
          <span className="font-[family-name:var(--font-mono)]">{item.missingSince}</span>
        </p>
      )}
      {item.type === 'wont_decode' && (
        <p className="truncate text-[length:var(--text-base)] text-[var(--color-muted)]">
          <span className="font-[family-name:var(--font-mono)]">{item.filePath}</span> —{' '}
          <span className="font-[family-name:var(--font-mono)]">{item.error}</span>
        </p>
      )}
    </div>
  )
}

function formatDiffValue(value: FieldDiff['newValue']): string {
  return Array.isArray(value) ? value.join(', ') : String(value)
}

// The tag-write diff/approve/revert flow the server has had since M9 and
// the frontend has never touched (session 5). Nothing in the UI creates a
// tag_writes row yet — the metadata panel's pencil, which will, is session
// 6's job — so this section is normally empty on a real library. Built now
// so that wiring has somewhere real to land.
function TagWriteRow({
  tagWrite,
  onApprove,
  onRevert,
  onDiscard,
}: {
  tagWrite: TagWrite
  onApprove: () => void
  onRevert: () => void
  onDiscard: () => void
}) {
  const diff = JSON.parse(tagWrite.diff_json) as FieldDiff[];
  return (
    <div className="flex flex-col gap-[6px] border-b border-[var(--color-divider)] py-[15px] last:border-b-0">
      <div className="flex items-baseline justify-between gap-[12px]">
        <span className="text-[length:var(--text-base)] text-[var(--color-muted)]">
          tag write{' '}
          <span className="font-[family-name:var(--font-mono)] text-[var(--color-ink)]">#{tagWrite.id}</span>
        </span>
        <span className="shrink-0 text-[length:var(--text-base)] text-[var(--color-muted)]">
          {TAG_WRITE_STATUS_LABEL[tagWrite.status]}
        </span>
      </div>
      <ul className="flex flex-col gap-[2px]">
        {diff.map((d) => (
          <li key={d.field} className="text-[length:var(--text-base)] text-[var(--color-muted)]">
            {d.field}:{' '}
            <span className="font-[family-name:var(--font-mono)]">{formatDiffValue(d.oldValue)}</span> →{' '}
            <span className="font-[family-name:var(--font-mono)] text-[var(--color-ink)]">
              {formatDiffValue(d.newValue)}
            </span>
          </li>
        ))}
      </ul>
      {tagWrite.error_message && (
        // No dedicated error/danger token exists in the design system yet
        // (DESIGN.md's palette is all glass/ink/muted/edge-hue) — plain ink
        // rather than inventing an unauthorized color for one rare state.
        <p className="font-[family-name:var(--font-mono)] text-[length:var(--text-base)] text-[var(--color-ink)]">
          {tagWrite.error_message}
        </p>
      )}
      <div className="flex items-center gap-[16px]">
        {tagWrite.status === 'pending_review' && (
          <Button variant="destructive" onClick={onApprove}>
            approve
          </Button>
        )}
        {tagWrite.status === 'written' && <Button onClick={onRevert}>revert</Button>}
        {tagWrite.status !== 'written' && <Button onClick={onDiscard}>discard</Button>}
      </div>
    </div>
  )
}

export default function HygieneView({
  onSelectNode,
  onClose,
}: {
  onSelectNode: (id: number) => void
  onClose: () => void
}) {
  const { phase, requestClose } = useModalTransition(onClose)
  const [items, setItems] = useState<WorklistItem[] | null>(null)
  const [filter, setFilter] = useState<'all' | WorklistItem['type']>('all')
  const [tagWrites, setTagWrites] = useState<TagWrite[] | null>(null)

  const loadWorklist = useCallback(() => {
    fetch(`${API}/hygiene/worklist`)
      .then((r) => r.json())
      .then(setItems)
  }, [])

  const loadTagWrites = useCallback(() => {
    fetch(`${API}/tag-writes`)
      .then((r) => r.json())
      .then(setTagWrites)
  }, [])

  useEffect(() => {
    loadWorklist()
    loadTagWrites()
  }, [loadWorklist, loadTagWrites])

  // Resolving a fuzzy-pending match (merge-overrides.ts) or an enrichment
  // job finishing (worker.ts) both broadcast hygiene:changed — plus scan
  // events, since a re-scan can add/clear missing_file rows.
  useWsEvent(['hygiene:changed', 'scan:done', 'scan:file'], loadWorklist)
  useWsEvent(['tag-write:written', 'tag-write:reverted'], loadTagWrites)

  const resolveFuzzy = async (fileId: number, forcedRecordingNodeId: number | null) => {
    await fetch(`${API}/merge-overrides`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId, forcedRecordingNodeId }),
    })
    loadWorklist()
  }

  const approveTagWrite = async (id: number) => {
    await fetch(`${API}/tag-writes/${id}/approve`, { method: 'POST' })
    loadTagWrites()
  }

  const revertTagWrite = async (id: number) => {
    await fetch(`${API}/tag-writes/${id}/revert`, { method: 'POST' })
    loadTagWrites()
  }

  const discardTagWrite = async (id: number) => {
    await fetch(`${API}/tag-writes/${id}`, { method: 'DELETE' })
    loadTagWrites()
  }

  const visible = (items ?? []).filter((i) => filter === 'all' || i.type === filter)
  const pendingTagWrites = (tagWrites ?? []).filter((t) => t.status !== 'reverted')

  // Arriving is slower than leaving (MO-8: --motion-base in, --motion-exit
  // out) — the scrim and panel share one duration class so both layers
  // move together.
  const duration = phase === 'exiting' ? 'duration-[var(--motion-exit)]' : 'duration-[var(--motion-base)]'
  const entered = phase === 'entered'

  return (
    <div
      className={`fixed inset-0 z-30 flex items-center justify-center bg-[var(--color-canvas)]/40 p-[60px] backdrop-blur-[var(--blur-glass)] transition-opacity ${duration} ease-[var(--ease-out)] ${entered ? 'opacity-100' : 'opacity-0'}`}
    >
      <Surface
        className={`flex max-h-full w-full max-w-[900px] flex-col overflow-hidden transition-all ${duration} ease-[var(--ease-out)] motion-reduce:scale-100 ${entered ? 'scale-100 opacity-100' : 'scale-[0.985] opacity-0'}`}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--color-divider)] px-[var(--spacing-panel)] py-[21px]">
          <h2 className="text-[length:var(--text-base)] font-normal text-[var(--color-muted)]">maintenance</h2>
          <button
            type="button"
            onClick={requestClose}
            aria-label="Close maintenance"
            className="text-[var(--color-muted)] transition-colors duration-150 hover:text-[var(--color-muted-hi)]"
          >
            <Icon name="cancel" size={24} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-[var(--spacing-panel)] pb-[var(--spacing-panel)]">
          <div className="flex gap-[20px] pt-[15px]">
            {(['all', 'fuzzy_pending', 'enrichment_flag', 'missing_file', 'wont_decode'] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={`text-[length:var(--text-base)] transition-colors duration-150 ${
                  filter === f ? 'text-[var(--color-ink)]' : 'text-[var(--color-muted)] hover:text-[var(--color-muted-hi)]'
                }`}
              >
                {f === 'all' ? 'all' : TYPE_LABEL[f]}
              </button>
            ))}
          </div>

          {items === null ? (
            <p className="pt-[24px] text-[length:var(--text-base)] text-[var(--color-muted)]">loading…</p>
          ) : visible.length === 0 ? (
            // A success state, not an empty one — DESIGN.md "No maintenance
            // items ... should read as calm, not empty."
            <p className="pt-[24px] text-[length:var(--text-base)] text-[var(--color-muted)]">nothing needs attention</p>
          ) : (
            <div className="mt-[8px]">
              {visible.map((item, i) => (
                <WorklistRow key={i} item={item} onSelectNode={onSelectNode} onResolveFuzzy={resolveFuzzy} />
              ))}
            </div>
          )}

          {pendingTagWrites.length > 0 && (
            <>
              <SectionHeader title="tag writes" />
              <div className="mt-[8px]">
                {pendingTagWrites.map((tw) => (
                  <TagWriteRow
                    key={tw.id}
                    tagWrite={tw}
                    onApprove={() => approveTagWrite(tw.id)}
                    onRevert={() => revertTagWrite(tw.id)}
                    onDiscard={() => discardTagWrite(tw.id)}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </Surface>
    </div>
  )
}
