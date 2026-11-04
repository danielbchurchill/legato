import { useEffect, useState } from 'react'
import { Button } from '../ui/Button'
import { CoverArt } from '../ui/CoverArt'
import { StatusDot, type Status } from '../ui/StatusDot'
import { TextField } from '../ui/TextField'
import { useTouchLayout } from '../ui/touchLayout'
import { formatDuration, NO_VALUE } from '../ui/format'
import { BackRow } from '../shell/SidePanel'
import type { WorklistKind } from '../shell/panels'
import { useGraph } from '../canvas/graphContext'
import { API_BASE as API } from '../config/serverHost'
import { useReconnectEpoch } from '../connect/reconnect'
import { fileFactList, playsAfterMergeLine, type DuplicateFile, type DuplicatePair } from './duplicates'
import {
  formatDiffValue,
  formatWhen,
  parseDiff,
  useTagWrites,
  useWorklist,
  type GapView,
  type TagWrite,
  type WorklistItem,
} from './healthData'
import { MetadataGaps } from './MetadataGaps'
import { TitledContext } from './titledContext'
import { Card, Heading, Quiet } from './worklistParts'

/* The worklists Library health opens: each a page with a way back, a title
 * and count, one line on what it is, then the items with the action each
 * one needs. Nothing here writes to a file without an explicit "Write":
 * metadata added in the gaps list becomes a tag write to review, the same
 * path the details panel's edit takes. */

type WorklistProps = {
  kind: WorklistKind
  /** The gaps list's filter and order, kept by whoever shows it. */
  gapView: GapView
  onGapViewChange: (view: GapView) => void
  /** Omitted on the phone (#389), where a worklist is a pushed page whose
   * top bar carries the way back and the title, so neither is drawn here. */
  onBack?: () => void
  onFocusNode: (id: number) => void
}

export function Worklist({ kind, gapView, onGapViewChange, onBack, onFocusNode }: WorklistProps) {
  return (
    <TitledContext.Provider value={onBack != null}>
      <div className="flex flex-col">
        {onBack && <BackRow label="Library health" onBack={onBack} />}
        {kind === 'duplicates' && <Duplicates onFocusNode={onFocusNode} />}
        {kind === 'missing' && <MissingFiles onFocusNode={onFocusNode} />}
        {kind === 'enrichment' && <EnrichmentToConfirm onFocusNode={onFocusNode} />}
        {kind === 'tag-writes' && <TagWrites />}
        {kind === 'gaps' && <MetadataGaps view={gapView} onViewChange={onGapViewChange} onFocusNode={onFocusNode} />}
      </div>
    </TitledContext.Provider>
  )
}

/* ---- Possible duplicates --------------------------------------------------- */

/* The two sides' files and which one a merge would play, asked once per
 * card (bit depth means the server reads each file's header), and again
 * after an outage (#119). */
function useDuplicatePair(fileId: number): DuplicatePair | null {
  const [pair, setPair] = useState<DuplicatePair | null>(null)
  const reconnects = useReconnectEpoch()
  useEffect(() => {
    let cancelled = false
    fetch(`${API}/hygiene/duplicates/${fileId}`)
      .then((r) => (r.ok ? (r.json() as Promise<DuplicatePair>) : null))
      .then((value) => !cancelled && value && setPair(value))
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [fileId, reconnects])
  return pair
}

function DuplicateSide({
  nodeId,
  title,
  file,
  others,
  plays,
  onFocusNode,
}: {
  nodeId: number
  title: string
  file: DuplicateFile | null
  /** More files the track already has, beyond `file`. */
  others: number
  plays: boolean
  onFocusNode: (id: number) => void
}) {
  const graph = useGraph()
  const releaseId = graph.edges.find((e) => e.type === 'appears_on' && e.from_node === nodeId)?.to_node
  const album = releaseId != null ? graph.byId.get(releaseId)?.title : null
  const duration = formatDuration(graph.byId.get(nodeId)?.canonical_duration_ms)
  return (
    <div className="flex min-w-0 flex-col gap-[8px]">
      <button type="button" onClick={() => onFocusNode(nodeId)} className="flex min-w-0 flex-col gap-[8px] text-left">
        <CoverArt nodeId={nodeId} size="thumb" className="aspect-square w-full" />
        <span className="flex min-w-0 flex-col">
          <span title={title} className="truncate text-[length:var(--text-body)] leading-[20px] font-medium text-[var(--color-ink)]">
            {title}
          </span>
          <span title={album ?? undefined} className="truncate text-small text-[var(--color-ink-2)]">
            {album ?? NO_VALUE}
          </span>
        </span>
      </button>
      {file && (
        <span className="flex min-w-0 flex-col gap-[4px]">
          {/* Each fact whole, so a narrow side wraps between them. */}
          <span className="mono flex flex-wrap gap-x-[8px] text-[11px] leading-[15px] text-[var(--color-ink)]">
            {[duration, ...fileFactList(file)].filter(Boolean).map((fact) => (
              <span key={fact} className="whitespace-nowrap">
                {fact}
              </span>
            ))}
          </span>
          <span data-selectable className="mono text-[11px] leading-[15px] break-all text-[var(--color-ink-3)]">
            {file.path}
          </span>
          {file.missing && <span className="text-small text-[var(--color-bad)]">not on disk</span>}
          {others > 0 && (
            <span className="text-small text-[var(--color-ink-2)]">
              and {others} more {others === 1 ? 'file' : 'files'} on this track
            </span>
          )}
          {plays && (
            <span className="flex items-center gap-[6px] text-small text-[var(--color-ink)]">
              <StatusDot status="accent" />
              plays after a merge
            </span>
          )}
        </span>
      )}
    </div>
  )
}

function DuplicateCard({
  item,
  onResolve,
  onFocusNode,
}: {
  item: Extract<WorklistItem, { type: 'fuzzy_pending' }>
  onResolve: (forcedRecordingNodeId: number | null) => void
  onFocusNode: (id: number) => void
}) {
  const pair = useDuplicatePair(item.fileId)
  // The track it would join plays its best file today: the first of the
  // candidate list, which the server orders by the playback rule.
  const theirs = pair?.candidate[0] ?? null
  const winner = pair?.playsAfterMerge
  return (
    <Card>
      <div className="grid grid-cols-2 gap-[10px]">
        <DuplicateSide
          nodeId={item.nodeId}
          title={item.nodeTitle}
          file={pair?.file ?? null}
          others={0}
          plays={pair != null && winner === pair.file.id}
          onFocusNode={onFocusNode}
        />
        <DuplicateSide
          nodeId={item.candidateNodeId}
          title={item.candidateTitle}
          file={theirs}
          others={Math.max(0, (pair?.candidate.length ?? 0) - 1)}
          plays={pair != null && winner != null && winner !== pair.file.id}
          onFocusNode={onFocusNode}
        />
      </div>
      {pair && <p className="text-[length:var(--text-secondary)] leading-[18px] text-[var(--color-ink-2)]">{playsAfterMergeLine(pair)}</p>}
      <div className="flex gap-[8px]">
        <Button variant="primary" onClick={() => onResolve(item.candidateNodeId)}>
          Merge
        </Button>
        <Button variant="secondary" onClick={() => onResolve(null)}>
          Keep both
        </Button>
      </div>
    </Card>
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
        These files look like the same recording. Merge puts them under one track and deletes no file: both stay on disk, and the track
        plays the one with the higher bitrate. Keep both leaves them as two tracks.
      </Heading>
      <div className="flex flex-col gap-[10px]">
        {items.map((item) => (
          <DuplicateCard
            key={item.fileId}
            item={item}
            onResolve={(forced) => void resolve(item.fileId, forced)}
            onFocusNode={onFocusNode}
          />
        ))}
        {data && items.length === 0 && <Quiet>No possible duplicates.</Quiet>}
      </div>
    </>
  )
}

/* ---- Missing files ----------------------------------------------------------- */

type LibraryRoot = { id: number; path: string }

function MissingFiles({ onFocusNode }: { onFocusNode: (id: number) => void }) {
  const touch = useTouchLayout()
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
                className={`min-w-0 flex-1 text-left text-[length:var(--text-body)] leading-[20px] font-medium text-[var(--color-ink)] ${touch ? 'touch-target' : ''}`}
              >
                {/* Truncated inside, so the touch target isn't clipped. */}
                <span className="block truncate">{item.nodeTitle}</span>
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
  const touch = useTouchLayout()
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
      <button
        type="button"
        onClick={() => onFocusNode(item.nodeId)}
        className={`flex min-w-0 flex-col text-left ${touch ? 'touch-target' : ''}`}
      >
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
