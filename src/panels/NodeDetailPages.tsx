import { useEffect, useRef, useState } from 'react'
import { Icon } from '../ui/Icon'
import { DataRow, SectionHeader } from '../ui/DataRow'
import { ArticleBody } from '../ui/ArticleBody'
import { Button } from '../ui/Button'
import { Tooltip } from '../ui/Tooltip'
import { formatDuration } from '../ui/format'
import {
  API,
  type EditableFields,
  type Fact,
  type FieldDiff,
  type FileRow,
  type LyricsData,
  type NodeDetail,
  type SearchResult,
  type TagWriteRow,
} from './useNodeDetail'

/* Everything about a node below its cover and title: the metadata rows and
 * their edit -> dry-run diff -> approve flow, the generated facts, the manual
 * edges and the form that adds them, lyrics, and the article/description
 * page — carried across three pages of one horizontal pager.
 *
 * Lifted out of NowPlayingPanel so the inspector modal the canvas card opens
 * can render exactly the same thing. The panel keeps what is genuinely about
 * playback (the up-next list) and what is about its own shape (a cover the
 * full width of a 360px column); this is the part that is about the node.
 *
 * Editable fields are exactly the ones the tag write-back API actually
 * supports (server/src/tagwrite/fields.ts): bpm, label, release type.
 * release_date is shown too — it lives in the file tags same as the other
 * three — but stays read-only, since TagLib# has no writable "release date"
 * property distinct from the numeric year and adding one wasn't in scope
 * here. Title/artist/album are display only in this pass; editing those
 * touches match/collapse identity, a different question from fixing a wrong
 * bpm. Editing is file-scoped, so it only ever applies to recording nodes
 * (the only type with files).
 *
 * Pagination — the dots at the foot — covers metadata, lyrics, and article.
 * Lyrics only applies to recording nodes (LRCLIB keys off title+artist) and
 * is fetched lazily (only once the lyrics page is actually opened, not
 * eagerly when a track starts) since GET /nodes/:id/lyrics is a real network
 * round trip to LRCLIB on a cache miss — see migration 0017's comment on why
 * that can't happen during a scan. */

// baked into fact.text from the server.
const EDGE_VERB: Record<string, string> = {
  performed_by: 'Performed by',
  released_in: 'Released in',
  appears_on: 'Appears on',
  released_on: 'Released on',
  remix_of: 'Remix of',
  featured_artist: 'Featuring',
  produced_by: 'Produced by',
  engineered_by: 'Engineered by',
  collaborated_with: 'Collaborated with',
  same_artist: 'Same artist as',
  same_label: 'Same label as',
  mixed_by: 'Mixed by',
  mastered_by: 'Mastered by',
  arranged_by: 'Arranged by',
  conducted_by: 'Conducted by',
  remixed_by: 'Remixed by',
  dj_mixed_by: 'DJ-mixed by',
  performed_credit: 'Performed by',
}

const linkClass =
  'text-[var(--color-ink)] underline decoration-[var(--color-hairline)] underline-offset-2 hover:text-[var(--color-muted-hi)]'

// P-6: an artist with fifteen albums used to produce fifteen near-identical
// "Same artist as…" lines. Facts sharing a groupType collapse into one row;
// facts with no groupType (the aggregate sentences facts.ts already
// generates, like "12 recordings in your collection") are singletons by
// construction and pass through untouched.
function groupFacts(facts: Fact[]): { key: string; items: Fact[] }[] {
  const order: string[] = []
  const map = new Map<string, Fact[]>()
  for (const fact of facts) {
    const key = fact.groupType ?? `singleton:${fact.text}`
    if (!map.has(key)) {
      map.set(key, [])
      order.push(key)
    }
    map.get(key)!.push(fact)
  }
  return order.map((key) => ({ key, items: map.get(key)! }))
}

function FactLine({ fact, onSelectNode }: { fact: Fact; onSelectNode: (id: number) => void }) {
  if (fact.targetNodeId != null) {
    return (
      <button type="button" onClick={() => onSelectNode(fact.targetNodeId!)} className={`block w-full truncate text-left text-[length:var(--text-base)] ${linkClass}`}>
        {fact.text}
      </button>
    )
  }
  return <p className="text-[length:var(--text-base)] text-[var(--color-ink)]">{fact.text}</p>
}

function FactGroup({ groupType, items, onSelectNode }: { groupType: string; items: Fact[]; onSelectNode: (id: number) => void }) {
  const [open, setOpen] = useState(false)
  const verb = EDGE_VERB[groupType] ?? groupType

  if (items.length === 1) return <FactLine fact={items[0]} onSelectNode={onSelectNode} />

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-[8px] py-[1px] text-left text-[length:var(--text-base)] text-[var(--color-ink)] hover:text-[var(--color-muted-hi)]"
      >
        <span className="truncate">
          {verb} — {items.length} others
        </span>
        <Icon
          name="chevron-down"
          size={16}
          className={`shrink-0 text-[var(--color-muted)] transition-transform duration-[var(--motion-base)] ${open ? 'rotate-180' : ''}`}
        />
      </button>
      <div
        className={`grid transition-all duration-[var(--motion-base)] ease-[var(--ease-inout)] motion-reduce:transition-none ${
          open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
        }`}
      >
        <div className="min-h-0 overflow-hidden">
          <ul className="flex flex-col gap-[2px] py-[4px] pl-[12px]">
            {items.map((fact, i) => (
              <li key={i}>
                <FactLine fact={fact} onSelectNode={onSelectNode} />
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}

// "Sounds like", "sampled in", "played this at X" — the free-text personal
// edge layer from Legato.md's edge-types spec. First-class, never
// overwritten by re-scans (match/edges.ts only ever touches source='local').
function AddEdgeForm({ nodeId, onAdded }: { nodeId: number; onAdded: () => void }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [target, setTarget] = useState<SearchResult | null>(null)
  const [label, setLabel] = useState('')
  const [note, setNote] = useState('')

  useEffect(() => {
    if (!query.trim() || target) {
      setResults([])
      return
    }
    const handle = setTimeout(() => {
      fetch(`${API}/search?q=${encodeURIComponent(query)}`)
        .then((r) => r.json())
        .then(setResults)
    }, 200)
    return () => clearTimeout(handle)
  }, [query, target])

  const reset = () => {
    setOpen(false)
    setQuery('')
    setResults([])
    setTarget(null)
    setLabel('')
    setNote('')
  }

  const submit = async () => {
    if (!target || !label.trim()) return
    await fetch(`${API}/edges`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromNode: nodeId, toNode: target.id, type: 'personal', label, note: note || undefined }),
    })
    reset()
    onAdded()
  }

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)} className="mt-[8px]">
        + add edge
      </Button>
    )
  }

  return (
    <div className="mt-[8px] flex flex-col gap-[8px] rounded-[var(--radius-surface)] border border-[var(--color-hairline)] bg-[var(--color-inset)] p-[12px]">
      {target ? (
        <div className="flex items-center justify-between gap-[8px]">
          <span className="truncate font-[family-name:var(--font-mono)] text-[length:var(--text-base)] text-[var(--color-ink)]">
            → {target.title} <span className="text-[var(--color-muted)]">({target.type})</span>
          </span>
          <button
            type="button"
            onClick={() => setTarget(null)}
            className="shrink-0 text-[length:var(--text-base)] text-[var(--color-muted)] hover:text-[var(--color-muted-hi)]"
          >
            change
          </button>
        </div>
      ) : (
        <>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search for a node…"
            className="w-full bg-transparent text-[length:var(--text-base)] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-muted)]"
          />
          {results.length > 0 && (
            <ul className="flex max-h-[120px] flex-col overflow-y-auto">
              {results.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => setTarget(r)}
                    className="block w-full truncate py-[2px] text-left font-[family-name:var(--font-mono)] text-[length:var(--text-base)] text-[var(--color-ink)] hover:text-[var(--color-muted-hi)]"
                  >
                    {r.title} <span className="text-[var(--color-muted)]">({r.type})</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="relationship (e.g. sounds like)"
        className="w-full bg-transparent text-[length:var(--text-base)] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-muted)]"
      />
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="note (optional)"
        className="w-full bg-transparent text-[length:var(--text-base)] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-muted)]"
      />
      <div className="flex items-center gap-[16px]">
        <Button onClick={submit} disabled={!target || !label.trim()}>
          add
        </Button>
        <button type="button" onClick={reset} className="text-[length:var(--text-base)] text-[var(--color-muted)] hover:text-[var(--color-muted-hi)]">
          cancel
        </button>
      </div>
    </div>
  )
}

type NodeDetailPagesProps = {
  node: NodeDetail
  reload: () => void
  /** Whether this node is the recording currently loaded in the transport —
   * playback as an attribute of the node being viewed, per P-5, rather than
   * a fork into a separate component. */
  isPlaying: boolean
  onSelectNode: (id: number) => void
  onPlay: (nodeId: number, title: string) => void
}

export function NodeDetailPages({ node, reload, isPlaying, onSelectNode, onPlay }: NodeDetailPagesProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<EditableFields>({})
  const [pendingWrite, setPendingWrite] = useState<{ id: number; diff: FieldDiff[] } | null>(null)
  const [page, setPage] = useState(0)
  const [lyrics, setLyrics] = useState<LyricsData | 'loading' | null>(null)
  const swipeStartX = useRef<number | null>(null)

  // Reset the per-node view state whenever the node changes: a lyrics page
  // left open on the last track must not stay open, showing the last track's
  // lyrics, over a different one.
  useEffect(() => {
    setEditing(false)
    setPendingWrite(null)
    setPage(0)
    setLyrics(null)
  }, [node.id])

  const pages: Array<'metadata' | 'lyrics' | 'article'> = [
    'metadata' as const,
    ...(node.type === 'recording' ? (['lyrics'] as const) : []),
    ...(node.article || node.description ? (['article'] as const) : []),
  ]

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (editing) return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      if (e.key === 'ArrowLeft') setPage((p) => Math.max(0, p - 1))
      if (e.key === 'ArrowRight') setPage((p) => Math.min(pages.length - 1, p + 1))
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, pages.length])

  useEffect(() => {
    if (pages[page] !== 'lyrics' || lyrics !== null) return
    setLyrics('loading')
    fetch(`${API}/nodes/${node.id}/lyrics`)
      .then((r) => (r.ok ? (r.json() as Promise<LyricsData>) : null))
      .then(setLyrics)
      .catch(() => setLyrics(null))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id, page, lyrics])

  // MO-11: a single LRCLIB round trip has no measurable length — genuinely
  // indeterminate. Under ~400ms show nothing (most lookups land there);
  // past ~800ms shift the label once, non-looping, rather than pretend to
  // track progress that doesn't exist.
  const [lyricsWaitVisible, setLyricsWaitVisible] = useState(false)
  const [lyricsWaitLong, setLyricsWaitLong] = useState(false)
  useEffect(() => {
    if (lyrics !== 'loading') {
      setLyricsWaitVisible(false)
      setLyricsWaitLong(false)
      return
    }
    const shortTimer = setTimeout(() => setLyricsWaitVisible(true), 400)
    const longTimer = setTimeout(() => setLyricsWaitLong(true), 800)
    return () => {
      clearTimeout(shortTimer)
      clearTimeout(longTimer)
    }
  }, [lyrics])

  const file = node.files[0] as FileRow | undefined
  // Recordings connected to a non-recording node (e.g. every track by this
  // artist) — the incoming-edge half of the graph, rendered as a link list
  // since facts() only gives a count for these, not each individual node.
  const incomingRecordings = node.edges.filter((e) => e.direction === 'in' && e.other_type === 'recording')
  const manualEdges = node.edges.filter((e) => e.source === 'manual')
  const factGroups = groupFacts(node.facts)

  const deleteEdge = async (edgeId: number) => {
    await fetch(`${API}/edges/${edgeId}`, { method: 'DELETE' })
    reload()
  }

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
    reload()
  }

  const discardWrite = async () => {
    if (!pendingWrite) return
    await fetch(`${API}/tag-writes/${pendingWrite.id}`, { method: 'DELETE' })
    setPendingWrite(null)
  }

  const handleSwipeStart = (e: React.PointerEvent) => {
    swipeStartX.current = e.clientX
  }
  const handleSwipeEnd = (e: React.PointerEvent) => {
    if (swipeStartX.current == null) return
    const delta = e.clientX - swipeStartX.current
    swipeStartX.current = null
    if (Math.abs(delta) < 40) return
    if (delta < 0) setPage((p) => Math.min(pages.length - 1, p + 1))
    else setPage((p) => Math.max(0, p - 1))
  }

  return (
    <div className="flex flex-col">
      {/* One horizontal track with every page mounted, translated by
       * -page * 100% (MO-3) — arrow keys, the dots and a swipe all produce
       * the same transition, and direction is what tells you which way you
       * went. Pages differ wildly in height (lyrics can run long); letting
       * the row stretch to the tallest mounted page is simpler than
       * measuring the active one and costs nothing since the panel already
       * owns the scroll. */}
      <div className="mt-[15px] overflow-hidden" onPointerDown={handleSwipeStart} onPointerUp={handleSwipeEnd}>
        <div
          className="flex transition-transform duration-[var(--motion-base)] ease-[var(--ease-out)] motion-reduce:transition-none"
          style={{ transform: `translateX(-${page * 100}%)` }}
        >
          {pages.includes('metadata') && (
            <div className="w-full shrink-0" inert={pages[page] !== 'metadata'}>
              <SectionHeader
                title="metadata"
                action={
                  !editing &&
                  !pendingWrite && (
                    <div className="flex items-center gap-[16px]">
                      {node.recording && !isPlaying && (
                        <Tooltip label="Play">
                          <button
                            type="button"
                            onClick={() => onPlay(node.id, node.title)}
                            aria-label="Play"
                            className="text-[var(--color-muted)] transition-colors duration-150 hover:text-[var(--color-muted-hi)]"
                          >
                            <Icon name="play" size={24} />
                          </button>
                        </Tooltip>
                      )}
                      {file && (
                        <Tooltip label="Edit metadata">
                          <button
                            type="button"
                            onClick={startEditing}
                            aria-label="Edit metadata"
                            className="text-[var(--color-muted)] transition-colors duration-150 hover:text-[var(--color-muted-hi)]"
                          >
                            <Icon name="pencil" size={24} />
                          </button>
                        </Tooltip>
                      )}
                    </div>
                  )
                }
              />

              {node.recording && (
                <div className="mt-[8px]">
                  <DataRow label="track no." value={file?.track_no ?? '—'} />
                  <DataRow label="length" value={formatDuration(node.recording.canonical_duration_ms)} />
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
                        <Button onClick={submitDraft}>review changes</Button>
                        <button
                          type="button"
                          onClick={() => setEditing(false)}
                          className="text-[length:var(--text-base)] text-[var(--color-muted)] hover:text-[var(--color-muted-hi)]"
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
              )}

              {pendingWrite && (
                <>
                  <SectionHeader title="review diff" />
                  <ul className="mt-[8px] flex flex-col gap-[2px]">
                    {pendingWrite.diff.map((d) => (
                      <li key={d.field} className="text-[length:var(--text-base)] text-[var(--color-muted)]">
                        {d.field}: <span className="font-[family-name:var(--font-mono)]">{String(d.oldValue)}</span> →{' '}
                        <span className="font-[family-name:var(--font-mono)] text-[var(--color-ink)]">
                          {String(d.newValue)}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <div className="flex items-center gap-[16px] pt-[10px]">
                    <Button variant="destructive" onClick={approveWrite}>
                      approve — write to file
                    </Button>
                    <button
                      type="button"
                      onClick={discardWrite}
                      className="text-[length:var(--text-base)] text-[var(--color-muted)] hover:text-[var(--color-muted-hi)]"
                    >
                      discard
                    </button>
                  </div>
                </>
              )}

              {factGroups.length > 0 && (
                <ul className="mt-[8px] flex flex-col gap-[4px]">
                  {factGroups.map(({ key, items }) => (
                    <li key={key}>
                      {items[0].groupType ? (
                        <FactGroup groupType={items[0].groupType} items={items} onSelectNode={onSelectNode} />
                      ) : (
                        <FactLine fact={items[0]} onSelectNode={onSelectNode} />
                      )}
                    </li>
                  ))}
                </ul>
              )}

              {incomingRecordings.length > 0 && (
                <>
                  <SectionHeader title="recordings" />
                  <ul className="mt-[8px] flex max-h-[240px] flex-col gap-[2px] overflow-y-auto">
                    {incomingRecordings.map((e) => (
                      <li key={e.id}>
                        <button
                          type="button"
                          onClick={() => onSelectNode(e.other_id)}
                          className={`block w-full truncate py-[2px] text-left font-[family-name:var(--font-mono)] text-[length:var(--text-base)] ${linkClass}`}
                        >
                          {e.other_title}
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {node.mbid && (
                <div className="pt-[15px]">
                  <p className="text-[length:var(--text-base)] text-[var(--color-muted)]">mbid</p>
                  <p className="mt-[4px] break-all font-[family-name:var(--font-mono)] text-[length:var(--text-base)] text-[var(--color-ink)]">
                    {node.mbid}
                  </p>
                </div>
              )}

              {node.files.length > 1 && (
                <>
                  <SectionHeader title={`instances (${node.files.length})`} />
                  <ul className="mt-[8px] flex flex-col gap-[8px]">
                    {node.files.map((f) => (
                      <li key={f.file_path}>
                        <p className="font-[family-name:var(--font-mono)] text-[length:var(--text-base)] text-[var(--color-ink)]">
                          {f.format ?? '—'} · {f.bitrate ? `${Math.round(f.bitrate / 1000)}kbps` : '—'}
                        </p>
                        <p className="mt-[2px] break-all font-[family-name:var(--font-mono)] text-[length:var(--text-base)] text-[var(--color-ink)]">
                          {f.file_path}
                        </p>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              <SectionHeader title="personal edges" />
              {manualEdges.length > 0 && (
                <ul className="mt-[8px] flex flex-col gap-[6px]">
                  {manualEdges.map((e) => (
                    <li key={e.id} className="flex items-start justify-between gap-[8px]">
                      <div className="min-w-0">
                        <p className="text-[length:var(--text-base)] text-[var(--color-muted)]">
                          {e.direction === 'out' ? e.label : `${e.label} ←`}
                        </p>
                        <button
                          type="button"
                          onClick={() => onSelectNode(e.other_id)}
                          className={`truncate font-[family-name:var(--font-mono)] text-[length:var(--text-base)] ${linkClass}`}
                        >
                          {e.other_title}
                        </button>
                        {e.note && <p className="text-[length:var(--text-base)] text-[var(--color-muted)]">{e.note}</p>}
                      </div>
                      <button
                        type="button"
                        onClick={() => void deleteEdge(e.id)}
                        aria-label={`Remove edge to ${e.other_title}`}
                        className="shrink-0 text-[var(--color-muted)] transition-colors duration-150 hover:text-[var(--color-muted-hi)]"
                      >
                        <Icon name="cancel" size={18} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <AddEdgeForm nodeId={node.id} onAdded={reload} />
            </div>
          )}

          {pages.includes('lyrics') && (
            <div className="w-full shrink-0" inert={pages[page] !== 'lyrics'}>
              <SectionHeader title="lyrics" />
              {lyrics === 'loading' ? (
                lyricsWaitVisible && (
                  <p
                    className={`mt-[8px] text-[length:var(--text-base)] transition-colors duration-[var(--motion-fast)] ${
                      lyricsWaitLong ? 'text-[var(--color-ink)]' : 'text-[var(--color-muted)]'
                    }`}
                  >
                    loading lyrics…
                  </p>
                )
              ) : lyrics === null ? null : !lyrics.found ? (
                <p className="mt-[8px] text-[length:var(--text-base)] text-[var(--color-muted)]">no lyrics found</p>
              ) : lyrics.instrumental ? (
                <p className="mt-[8px] text-[length:var(--text-base)] text-[var(--color-muted)]">instrumental</p>
              ) : (
                <pre className="mt-[8px] whitespace-pre-wrap text-[length:var(--text-base)] leading-relaxed text-[var(--color-ink)]">
                  {lyrics.plainLyrics}
                </pre>
              )}
            </div>
          )}

          {pages.includes('article') && (
            <div className="w-full shrink-0" inert={pages[page] !== 'article'}>
              {/* Two kinds of prose on one page, in this order: who this is,
                * then what it is in *your* collection. The description comes
                * from outside (Wikipedia, via server/src/enrich/wikipedia.ts)
                * and is the same for everyone; the article below it is
                * generated from this library and is true of nobody else's. */}
              {node.description && (
                <>
                  <SectionHeader title="about" />
                  <p className="mt-[8px] text-[length:var(--text-base)] leading-relaxed text-[var(--color-ink)]">
                    {node.description.body}
                  </p>
                  {/* Attribution, not decoration: Wikipedia's text is CC BY-SA,
                    * so naming the source and its licence is an obligation the
                    * UI carries. The URL lives in the tooltip because this app
                    * has no way to open an external browser yet (no Tauri
                    * opener plugin) — a link that silently does nothing would
                    * be worse than text that can be read and typed. */}
                  <div className="mt-[8px] flex items-center gap-[6px] text-[length:var(--text-base)] text-[var(--color-muted)]">
                    <span>from {node.description.source}</span>
                    {node.description.license && <span>· {node.description.license}</span>}
                    {node.description.source_url && (
                      <Tooltip label={node.description.source_url} monospace>
                        <Icon name="info" size={16} />
                      </Tooltip>
                    )}
                  </div>
                </>
              )}
              {node.article && (
                <>
                  <SectionHeader title="article" />
                  <ArticleBody
                    bodyMd={node.article.body_md}
                    onSelectNode={onSelectNode}
                    className="mt-[8px] text-[length:var(--text-base)] leading-relaxed text-[var(--color-ink)]"
                  />
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* P-7: page dots sit at the panel's bottom edge in the mockup, not
       * directly under the title block — sticky rather than a Panel.tsx API
       * change, since the panel already owns the scrolling container. */}
      {pages.length > 1 && (
        <div className="sticky bottom-0 mt-[15px] flex justify-center gap-[6px] border-t border-[var(--color-divider)] bg-[var(--color-surface-flat)]/80 py-[12px] backdrop-blur-[var(--blur-glass)]">
          {pages.map((p, i) => (
            <button
              key={p}
              type="button"
              aria-label={`Page ${i + 1} of ${pages.length}: ${p}`}
              aria-current={i === page}
              onClick={() => setPage(i)}
              className={`h-[6px] w-[6px] rounded-full transition-colors duration-150 ${
                i === page ? 'bg-[var(--color-signal)]' : 'bg-[var(--color-hairline)]'
              }`}
            />
          ))}
        </div>
      )}
    </div>
  )
}
