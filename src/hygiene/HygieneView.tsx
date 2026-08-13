import { useCallback, useEffect, useState } from 'react'
import { useWsEvent } from '../hooks/useWs'

const API = 'http://127.0.0.1:8899/api/v1'

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

const TYPE_LABEL: Record<WorklistItem['type'], string> = {
  fuzzy_pending: 'possible duplicate',
  enrichment_flag: 'enrichment issue',
  missing_file: 'missing file',
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

export default function HygieneView({
  onSelectNode,
  onClose,
}: {
  onSelectNode: (id: number) => void
  onClose: () => void
}) {
  const [items, setItems] = useState<WorklistItem[] | null>(null)
  const [filter, setFilter] = useState<'all' | WorklistItem['type']>('all')

  const load = useCallback(() => {
    fetch(`${API}/hygiene/worklist`)
      .then((r) => r.json())
      .then(setItems)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Resolving a fuzzy-pending match (merge-overrides.ts) or an enrichment
  // job finishing (worker.ts) both broadcast hygiene:changed — plus scan
  // events, since a re-scan can add/clear missing_file rows. No manual
  // refresh needed for any of the three worklist categories.
  useWsEvent(['hygiene:changed', 'scan:done', 'scan:file'], load)

  const resolveFuzzy = async (fileId: number, forcedRecordingNodeId: number | null) => {
    await fetch(`${API}/merge-overrides`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId, forcedRecordingNodeId }),
    })
    load()
  }

  const visible = (items ?? []).filter((i) => filter === 'all' || i.type === filter)

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(10,10,10,0.97)',
        color: '#fff',
        fontFamily: 'monospace',
        fontSize: 13,
        padding: 24,
        overflowY: 'auto',
        zIndex: 30,
      }}
    >
      <button
        onClick={onClose}
        style={{ float: 'right', background: 'none', border: 'none', color: '#fff', cursor: 'pointer', fontSize: 16 }}
      >
        ✕
      </button>
      <h2 style={{ marginTop: 0 }}>Library hygiene</h2>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {(['all', 'fuzzy_pending', 'enrichment_flag', 'missing_file'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            style={{
              padding: '4px 10px',
              fontFamily: 'monospace',
              fontSize: 12,
              background: filter === f ? '#fff' : 'rgba(255,255,255,0.1)',
              color: filter === f ? '#111' : '#fff',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            {f === 'all' ? 'all' : TYPE_LABEL[f]}
          </button>
        ))}
      </div>

      {items === null ? (
        <div>loading…</div>
      ) : visible.length === 0 ? (
        <div style={{ opacity: 0.6 }}>Nothing needs attention.</div>
      ) : (
        <table style={{ borderCollapse: 'collapse', width: '100%', maxWidth: 900 }}>
          <thead>
            <tr style={{ textAlign: 'left', opacity: 0.6 }}>
              <th style={{ padding: 4 }}>type</th>
              <th style={{ padding: 4 }}>node</th>
              <th style={{ padding: 4 }}>detail</th>
              <th style={{ padding: 4 }}>action</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((item, i) => (
              <tr key={i} style={{ borderTop: '1px solid #333' }}>
                <td style={{ padding: 4, opacity: 0.6 }}>{TYPE_LABEL[item.type]}</td>
                <td style={{ padding: 4 }}>
                  <button style={linkStyle} onClick={() => onSelectNode(item.nodeId)}>
                    {item.nodeTitle}
                  </button>
                </td>
                <td style={{ padding: 4, maxWidth: 400 }}>
                  {item.type === 'fuzzy_pending' && (
                    <>
                      looks like{' '}
                      <button style={linkStyle} onClick={() => onSelectNode(item.candidateNodeId)}>
                        {item.candidateTitle}
                      </button>
                    </>
                  )}
                  {item.type === 'enrichment_flag' && <span style={{ wordBreak: 'break-word' }}>{item.note}</span>}
                  {item.type === 'missing_file' && (
                    <span style={{ wordBreak: 'break-all', opacity: 0.7 }}>
                      {item.filePath} (since {item.missingSince})
                    </span>
                  )}
                </td>
                <td style={{ padding: 4 }}>
                  {item.type === 'fuzzy_pending' && (
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        onClick={() => void resolveFuzzy(item.fileId, item.candidateNodeId)}
                        style={{ fontFamily: 'monospace', fontSize: 11 }}
                      >
                        merge
                      </button>
                      <button
                        onClick={() => void resolveFuzzy(item.fileId, null)}
                        style={{ fontFamily: 'monospace', fontSize: 11 }}
                      >
                        keep separate
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
