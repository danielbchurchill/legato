import { useEffect, useState } from 'react'
import { Icon } from '../ui/Icon'
import { SectionHeader } from '../ui/DataRow'
import { Button } from '../ui/Button'
import { formatLongDuration } from '../ui/format'
import { API, type Edge, type Fact, type NodeDetail, type SearchResult } from './useNodeDetail'

/* Everything relationship-shaped about a node: generated facts, incoming
 * recordings, and manual/personal edges plus the form that adds them. Data
 * this all reads from (node.edges, node.facts) was already fetched by
 * useNodeDetail regardless of which surface is asking, so there's no
 * separate loading state to manage here — unlike lyrics, this never needed
 * a lazy fetch, only a place to live.
 *
 * Split into individually-exported pieces (not one opaque block) because
 * NodeDetailPages' pager page interleaves mbid/instances between the
 * "recordings" and "personal edges" groups to match its pre-existing exact
 * layout, while NowPlayingSections' connections disclosure wants all three
 * contiguous — see ConnectionsBody at the bottom. */

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

const linkClass = 'text-[var(--color-ink)] hover:text-[var(--color-muted-hi)]'

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

export function FactGroupsList({ facts, onSelectNode }: { facts: Fact[]; onSelectNode: (id: number) => void }) {
  const factGroups = groupFacts(facts)
  if (factGroups.length === 0) return null
  return (
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
  )
}

// Issue #33: an artist's discography as its own section — real release
// entities (server/src/entities/aggregate.ts's albums table), not the
// flattened recording-by-recording list IncomingRecordingsList shows below
// it. Empty on every node but an artist, so this renders nothing there.
export function ReleasesList({ node, onSelectNode }: { node: NodeDetail; onSelectNode: (id: number) => void }) {
  if (node.releases.length === 0) return null
  return (
    <>
      <SectionHeader title="releases" />
      <ul className="mt-[8px] flex max-h-[240px] flex-col gap-[2px] overflow-y-auto">
        {node.releases.map((release) => (
          <li key={release.id} className="flex items-baseline justify-between gap-[8px]">
            <button
              type="button"
              onClick={() => onSelectNode(release.id)}
              className={`truncate py-[2px] text-left font-[family-name:var(--font-mono)] text-[length:var(--text-base)] ${linkClass}`}
            >
              {release.title}
            </button>
            <span className="shrink-0 text-[length:var(--text-base)] text-[var(--color-muted)]">
              {release.yearMin != null &&
                (release.yearMin === release.yearMax ? release.yearMin : `${release.yearMin}–${release.yearMax}`)}
              {release.yearMin != null && ' · '}
              {release.trackCount} track{release.trackCount === 1 ? '' : 's'} · {formatLongDuration(release.totalDurationMs)}
            </span>
          </li>
        ))}
      </ul>
    </>
  )
}

export function IncomingRecordingsList({ node, onSelectNode }: { node: NodeDetail; onSelectNode: (id: number) => void }) {
  // Recordings connected to a non-recording node (e.g. every track by this
  // artist) — the incoming-edge half of the graph, rendered as a link list
  // since facts() only gives a count for these, not each individual node.
  const incomingRecordings = node.edges.filter((e) => e.direction === 'in' && e.other_type === 'recording')
  if (incomingRecordings.length === 0) return null
  return (
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

export function PersonalEdgesSection({
  node,
  reload,
  onSelectNode,
}: {
  node: NodeDetail
  reload: () => void
  onSelectNode: (id: number) => void
}) {
  const manualEdges: Edge[] = node.edges.filter((e) => e.source === 'manual')

  const deleteEdge = async (edgeId: number) => {
    await fetch(`${API}/edges/${edgeId}`, { method: 'DELETE' })
    reload()
  }

  return (
    <>
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
    </>
  )
}

/** All three groups, contiguous — what the panel's connections disclosure
 * wants. The pager imports the three pieces above individually instead, to
 * interleave mbid/instances between "recordings" and "personal edges". */
export function ConnectionsBody({
  node,
  reload,
  onSelectNode,
}: {
  node: NodeDetail
  reload: () => void
  onSelectNode: (id: number) => void
}) {
  return (
    <>
      <FactGroupsList facts={node.facts} onSelectNode={onSelectNode} />
      <ReleasesList node={node} onSelectNode={onSelectNode} />
      <IncomingRecordingsList node={node} onSelectNode={onSelectNode} />
      <PersonalEdgesSection node={node} reload={reload} onSelectNode={onSelectNode} />
    </>
  )
}
