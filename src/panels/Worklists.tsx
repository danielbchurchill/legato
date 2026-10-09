import { useEffect, useState, type ReactNode } from 'react'
import { Button } from '../ui/Button'
import { Chip } from '../ui/Chip'
import { CoverArt } from '../ui/CoverArt'
import { StatusDot, type Status } from '../ui/StatusDot'
import { TextField } from '../ui/TextField'
import { formatCount, formatDuration, NO_VALUE } from '../ui/format'
import { BackRow } from '../shell/SidePanel'
import type { WorklistKind } from '../shell/panels'
import { useGraph } from '../canvas/graphContext'
import { API_BASE as API } from '../config/serverHost'
import { useReconnectEpoch } from '../connect/reconnect'
import {
  GAP_FIELDS,
  formatDiffValue,
  formatWhen,
  parseDiff,
  useGapCounts,
  useGapRows,
  useTagWrites,
  useWorklist,
  type GapField,
  type TagWrite,
  type WorklistItem,
} from './healthData'

/* The worklists Library health opens: each a page with a way back, a title
 * and count, one line on what it is, then the items with the action each
 * one needs. Nothing here writes to a file without an explicit "Write":
 * metadata added in the gaps list becomes a tag write to review, the same
 * path the details panel's edit takes. */

type WorklistProps = {
  kind: WorklistKind
  gapField: GapField
  onGapFieldChange: (field: GapField) => void
  onBack: () => void
  onFocusNode: (id: number) => void
}

export function Worklist({ kind, gapField, onGapFieldChange, onBack, onFocusNode }: WorklistProps) {
  return (
    <div className="flex flex-col">
      <BackRow label="Library health" onBack={onBack} />
      {kind === 'duplicates' && <Duplicates onFocusNode={onFocusNode} />}
      {kind === 'missing' && <MissingFiles onFocusNode={onFocusNode} />}
      {kind === 'enrichment' && <EnrichmentToConfirm onFocusNode={onFocusNode} />}
      {kind === 'tag-writes' && <TagWrites />}
      {kind === 'gaps' && <MetadataGaps field={gapField} onFieldChange={onGapFieldChange} onFocusNode={onFocusNode} />}
    </div>
  )
}

function Heading({ title, count, children }: { title: string; count: number | null; children: ReactNode }) {
  return (
    <>
      <div className="flex min-h-[36px] items-start justify-between gap-[8px]">
        <h2 className="text-title text-[var(--color-ink)]">{title}</h2>
        {count != null && (
          <span className="mono pt-[6px] text-[length:var(--text-mono)] text-[var(--color-ink-2)]">{formatCount(count)}</span>
        )}
      </div>
      <p className="mt-[6px] mb-[14px] text-[length:var(--text-secondary)] leading-[18px] [text-wrap:pretty] text-[var(--color-ink-2)]">
        {children}
      </p>
    </>
  )
}

function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`flex flex-col gap-[10px] rounded-[var(--radius-card)] bg-[var(--color-wash)] p-[12px] ${className}`}>{children}</div>
  )
}

function Quiet({ children }: { children: ReactNode }) {
  return <p className="pt-[12px] text-center text-[length:var(--text-secondary)] text-[var(--color-ink-2)]">{children}</p>
}

/* ---- Possible duplicates --------------------------------------------------- */

/* A recording's format isn't in the graph, so each side of a pair asks its
 * node once, and again after an outage (#119). */
function useFormat(nodeId: number): string | null {
  const [format, setFormat] = useState<string | null>(null)
  const reconnects = useReconnectEpoch()
  useEffect(() => {
    let cancelled = false
    fetch(`${API}/nodes/${nodeId}`)
      .then((r) => r.json())
      .then((node: { files: { format: string | null }[] }) => !cancelled && setFormat(node.files[0]?.format?.toUpperCase() ?? null))
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [nodeId, reconnects])
  return format
}

function DuplicateSide({ nodeId, title, onFocusNode }: { nodeId: number; title: string; onFocusNode: (id: number) => void }) {
  const graph = useGraph()
  const format = useFormat(nodeId)
  const releaseId = graph.edges.find((e) => e.type === 'appears_on' && e.from_node === nodeId)?.to_node
  const album = releaseId != null ? graph.byId.get(releaseId)?.title : null
  const duration = formatDuration(graph.byId.get(nodeId)?.canonical_duration_ms)
  return (
    <button type="button" onClick={() => onFocusNode(nodeId)} className="flex min-w-0 flex-col gap-[8px] text-left">
      <CoverArt nodeId={nodeId} size="thumb" className="aspect-square w-full" />
      <span className="flex min-w-0 flex-col">
        <span title={title} className="truncate text-[length:var(--text-body)] leading-[20px] font-medium text-[var(--color-ink)]">
          {title}
        </span>
        <span title={album ?? undefined} className="truncate text-small text-[var(--color-ink-2)]">
          {album ?? NO_VALUE}
        </span>
        <span className="mono text-[11px] text-[var(--color-ink-2)]">{[duration, format].filter(Boolean).join(' · ')}</span>
      </span>
    </button>
  )
}

function Duplicates({ onFocusNode }: { onFocusNode: (id: number) => void }) {
  const { data, reload } = useWorklist()
  const items = (data ?? []).filter((i): i is Extract<WorklistItem, { type: 'fuzzy_pending' }> => i.type === 'fuzzy_pending')
  const resolve = async (fileId: number, forcedRecordingNodeId: number | null) => {
    await fetch(`${API}/merge-overrides`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId, forcedRecordingNodeId }),
    })
    reload()
  }
  return (
    <>
      <Heading title="Possible duplicates" count={data ? items.length : null}>
        These files look like the same recording. Merging keeps both files under one track.
      </Heading>
      <div className="flex flex-col gap-[10px]">
        {items.map((item) => (
          <Card key={item.fileId}>
            <div className="grid grid-cols-2 gap-[10px]">
              <DuplicateSide nodeId={item.nodeId} title={item.nodeTitle} onFocusNode={onFocusNode} />
              <DuplicateSide nodeId={item.candidateNodeId} title={item.candidateTitle} onFocusNode={onFocusNode} />
            </div>
            <div className="flex gap-[8px]">
              <Button variant="primary" onClick={() => void resolve(item.fileId, item.candidateNodeId)}>
                Merge
              </Button>
              <Button variant="secondary" onClick={() => void resolve(item.fileId, null)}>
                Keep both
              </Button>
            </div>
          </Card>
        ))}
        {data && items.length === 0 && <Quiet>No possible duplicates.</Quiet>}
      </div>
    </>
  )
}

/* ---- Missing files ----------------------------------------------------------- */

type LibraryRoot = { id: number; path: string }

function MissingFiles({ onFocusNode }: { onFocusNode: (id: number) => void }) {
  const { data } = useWorklist()
  const [roots, setRoots] = useState<LibraryRoot[]>([])
  const [rescanned, setRescanned] = useState<number | null>(null)
  // Again after an outage (#119), when folders may have been added or
  // removed elsewhere.
  const reconnects = useReconnectEpoch()
  useEffect(() => {
    fetch(`${API}/library-roots`)
      .then((r) => r.json())
      .then(setRoots)
      .catch(() => undefined)
  }, [reconnects])
  const items = (data ?? []).filter((i) => i.type === 'missing_file' || i.type === 'wont_decode') as Extract<
    WorklistItem,
    { type: 'missing_file' | 'wont_decode' }
  >[]
  // The folders the missing files live under: a rescan of each finds files
  // that moved back, and drops the ones that are gone for good.
  const affected = roots.filter((root) => items.some((item) => item.filePath.startsWith(root.path)))
  const rescan = (root: LibraryRoot) => {
    setRescanned(root.id)
    void fetch(`${API}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ libraryRootId: root.id }),
    })
  }
  return (
    <>
      <Heading title="Missing files" count={data ? items.length : null}>
        Legato can't find or read these files where it last saw them. A drive that's unplugged shows up here too.
      </Heading>
      <div className="flex flex-col gap-[10px]">
        {items.map((item) => (
          <Card key={item.fileId} className="gap-[4px]">
            <div className="flex items-center gap-[8px]">
              <StatusDot status="bad" />
              <button
                type="button"
                onClick={() => onFocusNode(item.nodeId)}
                className="min-w-0 flex-1 truncate text-left text-[length:var(--text-body)] leading-[20px] font-medium text-[var(--color-ink)]"
              >
                {item.nodeTitle}
              </button>
              <span className="shrink-0 text-small text-[var(--color-ink-2)]">
                {item.type === 'missing_file' ? `since ${formatWhen(item.missingSince) ?? NO_VALUE}` : "won't decode"}
              </span>
            </div>
            <span data-selectable className="mono text-[11px] leading-[15px] break-all text-[var(--color-ink-3)]">
              {item.filePath}
            </span>
            {item.type === 'wont_decode' && (
              <span className="text-small [overflow-wrap:anywhere] text-[var(--color-ink-2)]">{item.error}</span>
            )}
          </Card>
        ))}
        {data && items.length === 0 && <Quiet>Every file is where Legato expects it.</Quiet>}
      </div>
      {affected.length > 0 && (
        <div className="mt-[14px] flex flex-wrap gap-[8px]">
          {affected.map((root) => (
            <Button key={root.id} variant="secondary" disabled={rescanned === root.id} onClick={() => rescan(root)}>
              {rescanned === root.id ? 'Rescanning…' : `Rescan ${root.path}`}
            </Button>
          ))}
        </div>
      )}
    </>
  )
}

/* ---- Enrichment to confirm ------------------------------------------------------ */

type Candidate = {
  id: number
  mbid: string
  release_title: string | null
  release_date: string | null
  score: number
  duration_delta_ms: number | null
}

function formatDelta(ms: number | null): string | null {
  if (ms == null) return null
  const sign = ms < 0 ? '−' : '+'
  return `${sign}${formatDuration(Math.abs(ms))}`
}

function EnrichmentItem({
  item,
  onDone,
  onFocusNode,
}: {
  item: Extract<WorklistItem, { type: 'enrichment_flag' }>
  onDone: () => void
  onFocusNode: (id: number) => void
}) {
  const graph = useGraph()
  const [candidates, setCandidates] = useState<Candidate[] | null>(null)
  const [chosen, setChosen] = useState<string | null>(null)
  // Again after an outage (#119), keeping the pick if it's still there.
  const reconnects = useReconnectEpoch()
  useEffect(() => {
    fetch(`${API}/hygiene/match-candidates/${item.nodeId}`)
      .then((r) => r.json())
      .then((list: Candidate[]) => {
        setCandidates(list)
        setChosen((prev) => (prev != null && list.some((c) => c.mbid === prev) ? prev : (list[0]?.mbid ?? null)))
      })
      .catch(() => setCandidates([]))
  }, [item.nodeId, reconnects])
  const use = async () => {
    if (!chosen) return
    await fetch(`${API}/hygiene/match-candidates/${item.nodeId}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mbid: chosen }),
    })
    onDone()
  }
  const subtitle = graph.byId.get(item.nodeId)?.subtitle
  return (
    <Card>
      <button type="button" onClick={() => onFocusNode(item.nodeId)} className="flex min-w-0 flex-col text-left">
        <span className="truncate text-[length:var(--text-body)] leading-[20px] font-medium text-[var(--color-ink)]">{item.nodeTitle}</span>
        {(subtitle || item.note) && (
          <span className="text-small [overflow-wrap:anywhere] text-[var(--color-ink-2)]">{subtitle ?? item.note}</span>
        )}
      </button>
      {candidates && candidates.length > 0 ? (
        <>
          <div role="radiogroup" aria-label={`Releases for ${item.nodeTitle}`} className="flex flex-col gap-[6px]">
            {candidates.map((c) => {
              const selected = c.mbid === chosen
              return (
                <button
                  key={c.mbid}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setChosen(c.mbid)}
                  className={`flex flex-col rounded-[var(--radius-control)] border px-[10px] py-[8px] text-left transition-colors duration-[var(--motion-fast)] ${
                    selected
                      ? 'border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)]'
                      : 'border-[var(--color-line)] hover:bg-[var(--color-wash)]'
                  }`}
                >
                  <span className="text-[length:var(--text-body)] leading-[20px] font-medium text-[var(--color-ink)]">
                    {c.release_title ?? c.mbid}
                  </span>
                  <span className="mono text-[11px] text-[var(--color-ink-2)]">
                    {[c.release_date?.slice(0, 4), `${Math.round(c.score * 100)}% match`, formatDelta(c.duration_delta_ms)]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </button>
              )
            })}
          </div>
          <div className="flex gap-[8px]">
            <Button variant="primary" disabled={!chosen} onClick={() => void use()}>
              Use this release
            </Button>
            <Button variant="secondary" onClick={onDone}>
              Skip
            </Button>
          </div>
        </>
      ) : (
        candidates && <ManualMatch nodeId={item.nodeId} onDone={onDone} />
      )}
    </Card>
  )
}

/* A track MusicBrainz found nothing for has no candidates to pick from
 * (#272). The way out is the recording's own MusicBrainz link: the server
 * looks it up once and applies it like any other match. Its error says
 * what to paste instead, so it's shown as it comes. */
function ManualMatch({ nodeId, onDone }: { nodeId: number; onDone: () => void }) {
  const [reference, setReference] = useState('')
  const [pending, setPending] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const submit = async () => {
    const value = reference.trim()
    if (!value || pending) return
    setPending(true)
    setProblem(null)
    try {
      const res = await fetch(`${API}/hygiene/manual-match/${nodeId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reference: value }),
      })
      if (res.ok) {
        onDone()
        return
      }
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      setProblem(body?.error ?? "That didn't match. Try the link again.")
    } catch {
      setProblem("Couldn't reach the Legato server.")
    } finally {
      setPending(false)
    }
  }
  return (
    <form
      className="flex flex-col gap-[8px]"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <span className="text-small text-[var(--color-ink-2)]">Nothing to pick from. Paste the track's MusicBrainz recording link.</span>
      <TextField
        label="MusicBrainz recording link or ID"
        placeholder="musicbrainz.org/recording/…"
        value={reference}
        onChange={setReference}
      />
      {problem && <p className="text-small [overflow-wrap:anywhere] text-[var(--color-bad)]">{problem}</p>}
      <div className="flex gap-[8px]">
        <Button variant="primary" type="submit" disabled={!reference.trim() || pending}>
          {pending ? 'Matching…' : 'Match'}
        </Button>
        <Button variant="secondary" onClick={onDone}>
          Skip
        </Button>
      </div>
    </form>
  )
}

function EnrichmentToConfirm({ onFocusNode }: { onFocusNode: (id: number) => void }) {
  const { data, reload } = useWorklist()
  // Skip moves past an item for now without changing anything; it's back
  // the next time the panel opens.
  const [skipped, setSkipped] = useState<Set<number>>(new Set())
  const items = (data ?? []).filter(
    (i): i is Extract<WorklistItem, { type: 'enrichment_flag' }> => i.type === 'enrichment_flag' && !skipped.has(i.nodeId),
  )
  return (
    <>
      <Heading title="Enrichment to confirm" count={data ? items.length : null}>
        Tracks MusicBrainz couldn't match on its own. Pick the release you own, or paste the track's MusicBrainz link.
      </Heading>
      <div className="flex flex-col gap-[10px]">
        {items.map((item) => (
          <EnrichmentItem
            key={item.nodeId}
            item={item}
            onFocusNode={onFocusNode}
            onDone={() => {
              setSkipped((prev) => new Set(prev).add(item.nodeId))
              reload()
            }}
          />
        ))}
        {data && items.length === 0 && <Quiet>Nothing left to confirm.</Quiet>}
      </div>
    </>
  )
}

/* ---- Tag writes ------------------------------------------------------------------ */

const TAG_STATUS: Record<TagWrite['status'], { dot: Status; label: (t: TagWrite) => string }> = {
  pending_review: { dot: 'accent', label: () => 'waiting for review' },
  approved: { dot: 'accent', label: () => 'writing…' },
  written: { dot: 'ok', label: (t) => `written ${formatWhen(t.written_at) ?? ''}`.trim() },
  failed: { dot: 'bad', label: () => "couldn't write" },
  reverted: { dot: 'idle', label: (t) => `reverted ${formatWhen(t.reverted_at) ?? ''}`.trim() },
}

export function DiffRows({
  diff,
}: {
  diff: { field: string; oldValue: string | number | string[]; newValue: string | number | string[] }[]
}) {
  return (
    <ul className="flex flex-col gap-[2px]">
      {diff.map((d) => (
        <li key={d.field} className="flex min-w-0 flex-wrap items-baseline gap-x-[6px] text-[length:var(--text-secondary)] leading-[18px]">
          <span className="text-[var(--color-ink-2)]">{d.field}</span>
          <span className="mono text-[length:var(--text-mono)] text-[var(--color-ink-3)] line-through">
            {formatDiffValue(d.oldValue) || NO_VALUE}
          </span>
          <span aria-hidden="true" className="text-[var(--color-ink-3)]">
            ›
          </span>
          <span className="mono text-[length:var(--text-mono)] [overflow-wrap:anywhere] text-[var(--color-ink)]">
            {formatDiffValue(d.newValue)}
          </span>
        </li>
      ))}
    </ul>
  )
}

function TagWrites() {
  const { data, reload } = useTagWrites()
  const act = async (path: string, method: 'POST' | 'DELETE') => {
    await fetch(`${API}${path}`, { method })
    reload()
  }
  const waiting = (data ?? []).filter((t) => t.status === 'pending_review').length
  return (
    <>
      <Heading title="Tag writes" count={data ? waiting : null}>
        Edits waiting to be written to your files, newest first. Anything written can be reverted here.
      </Heading>
      <div className="flex flex-col gap-[10px]">
        {(data ?? []).map((t) => {
          const status = TAG_STATUS[t.status]
          return (
            <Card key={t.id}>
              <div className="flex items-center gap-[8px]">
                <StatusDot status={status.dot} />
                <span className="flex-1 text-[length:var(--text-body)] leading-[20px] font-medium text-[var(--color-ink)]">
                  Tag write <span className="mono text-[length:var(--text-mono)]">#{t.id}</span>
                </span>
                <span className="text-small text-[var(--color-ink-2)]">{status.label(t)}</span>
              </div>
              <DiffRows diff={parseDiff(t)} />
              {t.error_message && <p className="mono text-[11px] [overflow-wrap:anywhere] text-[var(--color-bad)]">{t.error_message}</p>}
              {t.status === 'pending_review' && (
                <div className="flex gap-[8px]">
                  <Button variant="primary" onClick={() => void act(`/tag-writes/${t.id}/approve`, 'POST')}>
                    Write to file
                  </Button>
                  <Button variant="secondary" onClick={() => void act(`/tag-writes/${t.id}`, 'DELETE')}>
                    Discard
                  </Button>
                </div>
              )}
              {t.status === 'written' && (
                <Button variant="secondary" className="self-start" onClick={() => void act(`/tag-writes/${t.id}/revert`, 'POST')}>
                  Revert
                </Button>
              )}
              {t.status === 'failed' && (
                <Button variant="secondary" className="self-start" onClick={() => void act(`/tag-writes/${t.id}`, 'DELETE')}>
                  Discard
                </Button>
              )}
            </Card>
          )
        })}
        {data && data.length === 0 && <Quiet>No tag writes yet. Edits from a track's details land here for review.</Quiet>}
      </div>
    </>
  )
}

/* ---- Metadata gaps ------------------------------------------------------------- */

// The tag-write field each gap is filled through, and how its text becomes
// a value. "Unmatched" has no field: rescanning is the only remedy.
const GAP_WRITE: Partial<
  Record<GapField, { key: 'bpm' | 'label' | 'releaseDate' | 'releaseType'; parse: (v: string) => string | number | null; hint: string }>
> = {
  bpm: { key: 'bpm', parse: (v) => (/^\d+(\.\d+)?$/.test(v) ? Math.round(Number(v)) : null), hint: '120' },
  label: { key: 'label', parse: (v) => v || null, hint: 'Columbia' },
  release_date: { key: 'releaseDate', parse: (v) => (/^\d{4}(-\d{2}(-\d{2})?)?$/.test(v) ? v : null), hint: 'YYYY-MM-DD' },
  release_type: { key: 'releaseType', parse: (v) => v.toLowerCase() || null, hint: 'album' },
}

function MetadataGaps({
  field,
  onFieldChange,
  onFocusNode,
}: {
  field: GapField
  onFieldChange: (f: GapField) => void
  onFocusNode: (id: number) => void
}) {
  const counts = useGapCounts()
  const { data: rows, reload } = useGapRows(field)
  const [editing, setEditing] = useState<number | null>(null)
  const [value, setValue] = useState('')
  const [queued, setQueued] = useState<Set<number>>(new Set())
  const [problem, setProblem] = useState<string | null>(null)
  const write = GAP_WRITE[field]

  // Filling a gap proposes a tag write; the file changes only once that
  // write is approved under Tag writes.
  const save = async (nodeId: number) => {
    if (!write) return
    const parsed = write.parse(value.trim())
    if (parsed == null) {
      setProblem(`That doesn't look like a ${GAP_FIELDS.find((g) => g.field === field)!.chip}.`)
      return
    }
    const node = (await fetch(`${API}/nodes/${nodeId}`).then((r) => r.json())) as { files: { id: number }[] }
    const file = node.files[0]
    if (!file) return
    const res = await fetch(`${API}/tag-writes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId: file.id, changes: { [write.key]: parsed } }),
    })
    if (!res.ok) {
      setProblem("The server couldn't prepare that change.")
      return
    }
    setQueued((prev) => new Set(prev).add(nodeId))
    setEditing(null)
    setProblem(null)
  }

  const rescan = async (nodeId: number) => {
    await fetch(`${API}/nodes/${nodeId}/rescan`, { method: 'POST' })
    reload()
  }

  return (
    <>
      <Heading title="Metadata gaps" count={rows ? rows.length : null}>
        Tracks missing a tag the map and the library use. Anything you add waits under Tag writes until you write it.
      </Heading>
      <div className="flex flex-wrap gap-[6px]">
        {GAP_FIELDS.map((gap) => (
          <Chip key={gap.field} active={gap.field === field} count={counts?.[gap.field]} onClick={() => onFieldChange(gap.field)}>
            {gap.chip}
          </Chip>
        ))}
      </div>
      <ul className="-mx-[8px] mt-[12px] flex flex-col">
        {(rows ?? []).map((row) => (
          <li
            key={row.id}
            className={`flex flex-col rounded-[var(--radius-control)] px-[8px] ${editing === row.id ? 'bg-[var(--color-wash)] pb-[10px]' : ''}`}
          >
            <div className="flex h-[48px] items-center gap-[10px]">
              <button type="button" onClick={() => onFocusNode(row.id)} className="flex min-w-0 flex-1 flex-col text-left">
                <span
                  title={row.title}
                  className="truncate text-[length:var(--text-body)] leading-[20px] font-medium text-[var(--color-ink)]"
                >
                  {row.title}
                </span>
                <span className="truncate text-small text-[var(--color-ink-2)]">{row.artist ?? NO_VALUE}</span>
              </button>
              {queued.has(row.id) ? (
                <span className="text-small text-[var(--color-ink-3)]">in Tag writes</span>
              ) : (
                <span className="flex shrink-0 gap-[12px]">
                  {write && editing !== row.id && (
                    <Button
                      onClick={() => {
                        setEditing(row.id)
                        setValue('')
                        setProblem(null)
                      }}
                    >
                      add
                    </Button>
                  )}
                  <Button onClick={() => void rescan(row.id)}>rescan</Button>
                </span>
              )}
            </div>
            {editing === row.id && write && (
              <form
                className="flex items-center gap-[8px]"
                onSubmit={(e) => {
                  e.preventDefault()
                  void save(row.id)
                }}
              >
                <TextField
                  autoFocus
                  label={GAP_FIELDS.find((g) => g.field === field)!.chip}
                  placeholder={write.hint}
                  value={value}
                  onChange={setValue}
                  onEscape={() => setEditing(null)}
                  className="flex-1"
                />
                <Button variant="primary" type="submit" disabled={!value.trim()}>
                  Save
                </Button>
              </form>
            )}
            {editing === row.id && problem && <p className="pt-[6px] text-small text-[var(--color-bad)]">{problem}</p>}
          </li>
        ))}
      </ul>
      {rows && rows.length === 0 && <Quiet>Nothing missing here.</Quiet>}
    </>
  )
}
