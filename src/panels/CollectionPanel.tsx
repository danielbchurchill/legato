import { useEffect, useState } from 'react'
import { Icon } from '../ui/Icon'
import { DataRow, SectionHeader } from '../ui/DataRow'

const API = 'http://127.0.0.1:8899/api/v1'

/* The left-hand panel.
 *
 * Search is real: it hits the FTS5 index that has existed since M5 and was
 * previously reachable only from inside the add-edge form. Selecting a result
 * selects the node, which the canvas already follows. Filtering the graph and
 * flying the camera to a match is session 5.
 *
 * The similarity strips ("more like this" / "completely different") are absent
 * rather than stubbed — nothing computes similarity yet, and a strip of grey
 * squares would read as broken art rather than as an unbuilt feature.
 *
 * Overview shows the graph counts the canvas HUD used to carry. The real
 * collection stats — artists, albums, tracks, size, duration, top artist —
 * need an endpoint and a plays table that do not exist yet (session 3). */

type SearchResult = { id: number; type: string; title: string }

function SearchField({ onSelectNode }: { onSelectNode: (id: number) => void }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])

  useEffect(() => {
    const trimmed = query.trim()
    if (trimmed.length < 2) {
      setResults([])
      return
    }

    // Debounced so typing does not fire a query per keystroke at the server.
    const timer = setTimeout(() => {
      fetch(`${API}/search?q=${encodeURIComponent(trimmed)}&limit=8`)
        .then((r) => r.json())
        .then(setResults)
        .catch(() => setResults([]))
    }, 200)

    return () => clearTimeout(timer)
  }, [query])

  return (
    <div>
      {/* Inset, not raised: the field's fill is the canvas color and it casts
       * no shadow. See DESIGN.md "Raised and inset". */}
      <div className="flex h-[61px] items-center gap-[12px] rounded-[var(--radius-surface)] border border-[var(--color-hairline)] bg-[var(--color-inset)] px-[20px]">
        <Icon name="search" size={24} className="text-[var(--color-muted)]" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Search collection"
          className="min-w-0 flex-1 bg-transparent text-[length:var(--text-base)] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-muted)]"
        />
      </div>

      {results.length > 0 && (
        <ul className="mt-[12px] flex flex-col">
          {results.map((result) => (
            <li key={result.id}>
              <button
                type="button"
                onClick={() => {
                  onSelectNode(result.id)
                  setQuery('')
                }}
                className="grid w-full grid-cols-[1fr_auto] items-center gap-[10px] py-[6px] text-left"
              >
                <span className="truncate font-[family-name:var(--font-mono)] text-[length:var(--text-base)] text-[var(--color-ink)]">
                  {result.title}
                </span>
                <span className="text-[length:var(--text-base)] text-[var(--color-muted)]">
                  {result.type}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

type CollectionPanelProps = {
  nodeCount: number
  edgeCount: number
  onSelectNode: (id: number) => void
}

export function CollectionPanel({ nodeCount, edgeCount, onSelectNode }: CollectionPanelProps) {
  return (
    <div className="flex flex-col">
      <SearchField onSelectNode={onSelectNode} />

      <SectionHeader title="overview" />
      <div className="mt-[8px]">
        <DataRow label="nodes" value={nodeCount.toLocaleString()} />
        <DataRow label="edges" value={edgeCount.toLocaleString()} />
      </div>
    </div>
  )
}
