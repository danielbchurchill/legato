import { useEffect, useState } from 'react'

const API = 'http://127.0.0.1:8899/api/v1'

type Fact = { text: string; targetNodeId?: number }
type Edge = {
  id: number
  type: string
  source: string
  label: string | null
  note: string | null
  direction: 'in' | 'out'
  other_id: number
  other_title: string
  other_type: string
}
type FileInstance = { file_path: string; format: string | null; bitrate: number | null }
type SearchResult = { id: number; type: string; title: string }

type NodeDetail = {
  id: number
  type: string
  title: string
  mbid: string | null
  recording?: { canonical_duration_ms: number | null } | null
  files: FileInstance[]
  facts: Fact[]
  edges: Edge[]
  article: { body_md: string } | null
}

function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '—'
  const totalSeconds = Math.round(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

const linkStyle: React.CSSProperties = {
  color: '#7fb8ff',
  cursor: 'pointer',
  textDecoration: 'underline',
  background: 'none',
  border: 'none',
  padding: 0,
  font: 'inherit',
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  background: '#1a1a1a',
  border: '1px solid #444',
  color: '#fff',
  fontFamily: 'monospace',
  fontSize: 12,
  padding: '4px 6px',
  marginBottom: 6,
  boxSizing: 'border-box',
}

// "Sounds like", "sampled in", "played this at X" — the free-text personal
// edge layer from Legato.md's edge-types spec. First-class, never
// overwritten by re-scans (match/edges.ts only ever touches source='local').
function AddEdgeForm({ nodeId, onAdded }: { nodeId: number; onAdded: () => void }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [target, setTarget] = useState<SearchResult | null>(null)
  const [label, setLabel] = useState('')
  const [note, setNote] = useState('')
  const [open, setOpen] = useState(false)

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

  const submit = async () => {
    if (!target || !label.trim()) return
    await fetch(`${API}/edges`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromNode: nodeId, toNode: target.id, type: 'personal', label, note: note || undefined }),
    })
    setQuery('')
    setTarget(null)
    setLabel('')
    setNote('')
    setOpen(false)
    onAdded()
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} style={{ ...linkStyle, marginTop: 4 }}>
        + add edge
      </button>
    )
  }

  return (
    <div style={{ marginTop: 8, padding: 8, border: '1px solid #333' }}>
      {target ? (
        <div style={{ marginBottom: 6 }}>
          → {target.title} ({target.type}){' '}
          <button style={linkStyle} onClick={() => setTarget(null)}>
            change
          </button>
        </div>
      ) : (
        <>
          <input
            style={inputStyle}
            placeholder="search for a node…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {results.length > 0 && (
            <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 6px', maxHeight: 120, overflowY: 'auto' }}>
              {results.map((r) => (
                <li key={r.id}>
                  <button style={{ ...linkStyle, display: 'block', width: '100%', textAlign: 'left' }} onClick={() => setTarget(r)}>
                    {r.title} ({r.type})
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <input
        style={inputStyle}
        placeholder="relationship (e.g. sounds like)"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
      />
      <input style={inputStyle} placeholder="note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      <div style={{ display: 'flex', gap: 6 }}>
        <button onClick={submit} disabled={!target || !label.trim()} style={{ fontFamily: 'monospace', fontSize: 11 }}>
          add
        </button>
        <button onClick={() => setOpen(false)} style={{ fontFamily: 'monospace', fontSize: 11 }}>
          cancel
        </button>
      </div>
    </div>
  )
}

export default function ArticlePanel({
  nodeId,
  onSelectNode,
  onClose,
  onPlay,
}: {
  nodeId: number
  onSelectNode: (id: number) => void
  onClose: () => void
  onPlay: (nodeId: number, title: string) => void
}) {
  const [node, setNode] = useState<NodeDetail | null>(null)

  const load = () => {
    fetch(`${API}/nodes/${nodeId}`)
      .then((r) => r.json())
      .then(setNode)
  }

  useEffect(() => {
    setNode(null)
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId])

  const deleteEdge = async (edgeId: number) => {
    await fetch(`${API}/edges/${edgeId}`, { method: 'DELETE' })
    load()
  }

  // Recordings connected to a non-recording node (e.g. every track by this
  // artist) — the incoming-edge half of the graph, rendered as a link list
  // since facts() only gives a count for these, not each individual node.
  const incomingRecordings = node?.edges.filter((e) => e.direction === 'in' && e.other_type === 'recording') ?? []
  const manualEdges = node?.edges.filter((e) => e.source === 'manual') ?? []

  // Renders inside the shell's right-hand Panel, which owns the glass, the
  // padding and the scrolling. The inline styles below are pre-design-pass
  // code kept working until the node-detail surface is redesigned — they are
  // not a pattern to copy. See DESIGN.md.
  return (
    <div style={{ color: '#fff', fontFamily: 'monospace', fontSize: 13 }}>
      <button
        onClick={onClose}
        style={{ float: 'right', background: 'none', border: 'none', color: '#fff', cursor: 'pointer' }}
      >
        ✕
      </button>

      {!node ? (
        <div>loading…</div>
      ) : (
        <>
          <h3 style={{ marginTop: 0, marginBottom: 4 }}>{node.title}</h3>
          <div style={{ opacity: 0.6, marginBottom: 12 }}>{node.type}</div>

          {node.recording && (
            <div style={{ marginBottom: 8 }}>
              duration: {formatDuration(node.recording.canonical_duration_ms)}{' '}
              <button
                onClick={() => onPlay(node.id, node.title)}
                style={{ fontFamily: 'monospace', fontSize: 11, cursor: 'pointer' }}
              >
                ▶ play
              </button>
            </div>
          )}

          {node.facts.length > 0 && (
            <ul style={{ paddingLeft: 16, margin: '0 0 12px' }}>
              {node.facts.map((fact, i) => (
                <li key={i} style={{ marginBottom: 4 }}>
                  {fact.targetNodeId != null ? (
                    <button style={linkStyle} onClick={() => onSelectNode(fact.targetNodeId!)}>
                      {fact.text}
                    </button>
                  ) : (
                    fact.text
                  )}
                </li>
              ))}
            </ul>
          )}

          {incomingRecordings.length > 0 && (
            <>
              <div style={{ opacity: 0.6, marginTop: 8 }}>recordings</div>
              <ul style={{ paddingLeft: 16, margin: '4px 0 12px', maxHeight: 200, overflowY: 'auto' }}>
                {incomingRecordings.map((e) => (
                  <li key={e.id} style={{ marginBottom: 2 }}>
                    <button style={linkStyle} onClick={() => onSelectNode(e.other_id)}>
                      {e.other_title}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}

          {node.mbid && <div style={{ marginBottom: 8, wordBreak: 'break-all', opacity: 0.6 }}>mbid: {node.mbid}</div>}

          {node.files.length > 0 && (
            <>
              <div style={{ marginTop: 12, opacity: 0.6 }}>
                instances ({node.files.length})
                {node.files.length > 1 ? ' — collapsed from multiple releases' : ''}
              </div>
              <ul style={{ paddingLeft: 16, margin: '4px 0' }}>
                {node.files.map((f) => (
                  <li key={f.file_path} style={{ marginBottom: 4, wordBreak: 'break-all' }}>
                    {f.format ?? '?'} · {f.bitrate ? `${Math.round(f.bitrate / 1000)}kbps` : '?'}
                    <br />
                    <span style={{ opacity: 0.5 }}>{f.file_path}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          <div style={{ opacity: 0.6, marginTop: 12 }}>personal edges</div>
          {manualEdges.length > 0 && (
            <ul style={{ paddingLeft: 16, margin: '4px 0' }}>
              {manualEdges.map((e) => (
                <li key={e.id} style={{ marginBottom: 4 }}>
                  {e.direction === 'out' ? e.label : `${e.label} ←`}{' '}
                  <button style={linkStyle} onClick={() => onSelectNode(e.other_id)}>
                    {e.other_title}
                  </button>{' '}
                  <button style={{ ...linkStyle, color: '#f66' }} onClick={() => void deleteEdge(e.id)}>
                    ✕
                  </button>
                  {e.note && <div style={{ opacity: 0.5, marginLeft: 4 }}>{e.note}</div>}
                </li>
              ))}
            </ul>
          )}
          <AddEdgeForm nodeId={node.id} onAdded={load} />
        </>
      )}
    </div>
  )
}
